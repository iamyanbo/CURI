// PROTECTED benchmark harness for the fused multi-head attention domain.
// The candidate cannot read or modify this file.
//
// It owns everything that could be gamed:
//   * input generation (seeded, deterministic)
//   * FLOP bookkeeping
//   * the correctness reference (double precision, on CPU)
//   * the timing loop, including cudaDeviceSynchronize
//   * the shape list, half of which the candidate has never seen
//
// The candidate supplies only run_attention(). It never touches a timer.
//
// Contract of run_attention:
//   extern "C" void run_attention(const float* Q, const float* K,
//                                 const float* V, float* O,
//                                 int B, int H, int T, int D);
// Q,K,V,O are fp32 with layout [B][H][T][D]. O is the attention output.
//
// Metric: achieved TFLOP/s = 4*B*H*T*T*D / elapsed_seconds.

#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <vector>
#include <algorithm>

extern "C" void run_attention(const float* Q, const float* K, const float* V,
                              float* O, int B, int H, int T, int D);

struct Shape { int B, H, T, D; int visible; };

// Visible shapes are documented to the candidate. Held-back shapes are not:
// a kernel that special-cases what it can see will diverge here. All fit in a
// small fraction of the ~1.1 GB free VRAM on this device.
static const Shape SHAPES[] = {
  {1, 8, 256, 64, 1}, {1, 4, 512, 64, 1}, {1, 16, 128, 64, 1},
  {2, 4, 192, 64, 0}, {1, 12, 300, 64, 0}, {1, 8, 384, 96, 0},
};
static const int NSHAPES = sizeof(SHAPES) / sizeof(Shape);

static double attention_flops(int B, int H, int T, int D) {
  // QK^T and PV each cost 2*B*H*T*T*D flops.
  return 4.0 * (double)B * H * T * T * D;
}

static void fill(std::vector<float>& v, unsigned seed) {
  unsigned s = seed;
  for (size_t i = 0; i < v.size(); ++i) {
    s = s * 1664525u + 1013904223u;                       // deterministic LCG
    v[i] = ((float)(s >> 8) / 8388608.0f - 1.0f) * 2.0f;  // roughly [-2, 2]
  }
}

// Reference in double precision so fp32 kernel error is measured, not masked.
static void reference(const std::vector<float>& Q, const std::vector<float>& K,
                      const std::vector<float>& V, std::vector<double>& O,
                      int B, int H, int T, int D) {
  const double inv = 1.0 / std::sqrt((double)D);
  std::vector<double> s((size_t)T);
  for (int b = 0; b < B; ++b) {
    for (int h = 0; h < H; ++h) {
      const size_t hb = ((size_t)b * H + h);
      const float* qb = Q.data() + hb * T * D;
      const float* kb = K.data() + hb * T * D;
      const float* vb = V.data() + hb * T * D;
      double* ob = O.data() + hb * T * D;
      for (int i = 0; i < T; ++i) {
        double mx = -1e300;
        for (int j = 0; j < T; ++j) {
          double acc = 0.0;
          for (int d = 0; d < D; ++d) acc += (double)qb[(size_t)i * D + d] * (double)kb[(size_t)j * D + d];
          s[j] = acc * inv;
          mx = std::max(mx, s[j]);
        }
        double sum = 0.0;
        for (int j = 0; j < T; ++j) { s[j] = std::exp(s[j] - mx); sum += s[j]; }
        for (int d = 0; d < D; ++d) {
          double acc = 0.0;
          for (int j = 0; j < T; ++j) acc += s[j] * (double)vb[(size_t)j * D + d];
          ob[(size_t)i * D + d] = acc / sum;
        }
      }
    }
  }
}

int main(int argc, char** argv) {
  int reps = 120, warmup = 10;
  unsigned seed = 1337u;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--reps") && i + 1 < argc) reps = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--seed") && i + 1 < argc) seed = (unsigned)atoi(argv[++i]);
  }

  cudaDeviceProp prop; cudaGetDeviceProperties(&prop, 0);
  // fp32 peak from shipped SM/clock figures: 128 fp32 lanes/SM, 2 flops/lane.
  double peak_tflops_fp32 = 2.0 * prop.multiProcessorCount * 128 *
    prop.clockRate * 1e3 / 1e12;

  printf("{\n  \"device\": \"%s\",\n  \"peak_tflops_fp32\": %.3f,"
         "  \"reps\": %d,\n  \"shapes\": [\n",
         prop.name, peak_tflops_fp32, reps);

  double vis_sum = 0, hid_sum = 0; int vis_n = 0, hid_n = 0;
  double worst_viol = 0.0;
  int correct_all = 1;

  // Correctness rule: relative error with an absolute floor. The floor matters
  // because attention outputs are weighted averages that can legitimately land
  // near zero, where a pure relative test would demand impossible absolute
  // precision from fp32 accumulators.
  const double TOL_REL = 3e-3, TOL_ABS = 1e-4;

  for (int s = 0; s < NSHAPES; ++s) {
    int B = SHAPES[s].B, H = SHAPES[s].H, T = SHAPES[s].T, D = SHAPES[s].D;
    size_t n = (size_t)B * H * T * D, bytes = n * sizeof(float);
    double flops = attention_flops(B, H, T, D);

    std::vector<float> h_q(n), h_k(n), h_v(n), h_o(n);
    std::vector<double> h_ref(n);
    fill(h_q, seed + 3 * s + 0); fill(h_k, seed + 3 * s + 1); fill(h_v, seed + 3 * s + 2);
    reference(h_q, h_k, h_v, h_ref, B, H, T, D);

    float *d_q = nullptr, *d_k = nullptr, *d_v = nullptr, *d_o = nullptr;
    cudaMalloc(&d_q, bytes); cudaMalloc(&d_k, bytes);
    cudaMalloc(&d_v, bytes); cudaMalloc(&d_o, bytes);
    cudaMemcpy(d_q, h_q.data(), bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_k, h_k.data(), bytes, cudaMemcpyHostToDevice);
    cudaMemcpy(d_v, h_v.data(), bytes, cudaMemcpyHostToDevice);
    // Poison the output so a kernel that writes nothing cannot pass by accident.
    cudaMemset(d_o, 0xFF, bytes);

    for (int w = 0; w < warmup; ++w) run_attention(d_q, d_k, d_v, d_o, B, H, T, D);
    cudaDeviceSynchronize();

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
      printf("    {\"B\":%d,\"H\":%d,\"T\":%d,\"D\":%d,\"error\":\"%s\"}%s\n",
             B, H, T, D, cudaGetErrorString(err), s + 1 < NSHAPES ? "," : "");
      correct_all = 0;
      cudaFree(d_q); cudaFree(d_k); cudaFree(d_v); cudaFree(d_o);
      continue;
    }

    cudaMemcpy(h_o.data(), d_o, bytes, cudaMemcpyDeviceToHost);
    double maxviol = 0.0;
    int ok = 1;
    for (size_t i = 0; i < n; ++i) {
      double v = (double)h_o[i];
      if (!std::isfinite(v)) { maxviol = 1e9; ok = 0; break; }
      double e = std::fabs(v - h_ref[i]);
      double tol = std::max(TOL_REL * std::fabs(h_ref[i]), TOL_ABS);
      double viol = (tol > 0.0) ? (e / tol) : (e > 0.0 ? 1.0 : 0.0);
      if (viol > maxviol) maxviol = viol;
      if (viol >= 1.0) ok = 0;
    }
    worst_viol = std::max(worst_viol, maxviol);
    if (!ok) correct_all = 0;

    // Timing is ours. Each rep is individually synchronised, so a kernel cannot
    // be credited for work that has not finished.
    std::vector<double> times;
    cudaEvent_t a, b; cudaEventCreate(&a); cudaEventCreate(&b);
    for (int r = 0; r < reps; ++r) {
      cudaEventRecord(a);
      run_attention(d_q, d_k, d_v, d_o, B, H, T, D);
      cudaEventRecord(b);
      cudaEventSynchronize(b);
      float ms = 0; cudaEventElapsedTime(&ms, a, b);
      times.push_back((double)ms);
    }
    cudaEventDestroy(a); cudaEventDestroy(b);
    std::sort(times.begin(), times.end());
    double med = times[times.size() / 2];
    double p10 = times[times.size() / 10];
    double tflops = flops / (p10 * 1e-3) / 1e12;

    if (SHAPES[s].visible) { vis_sum += tflops; vis_n++; } else { hid_sum += tflops; hid_n++; }

    printf("    {\"B\":%d,\"H\":%d,\"T\":%d,\"D\":%d,\"visible\":%d,\"median_ms\":%.6f,"
           "\"p10_ms\":%.6f,\"tflops\":%.3f,\"flops\":%.0f,\"max_viol\":%.3e,\"correct\":%d}%s\n",
           B, H, T, D, SHAPES[s].visible, med, p10, tflops, flops, maxviol, ok,
           s + 1 < NSHAPES ? "," : "");

    cudaFree(d_q); cudaFree(d_k); cudaFree(d_v); cudaFree(d_o);
  }

  printf("  ],\n  \"visible_tflops\": %.3f,\n  \"hidden_tflops\": %.3f,\n"
         "  \"worst_viol\": %.3e,\n  \"correct\": %d\n}\n",
         vis_n ? vis_sum / vis_n : 0.0, hid_n ? hid_sum / hid_n : 0.0,
         worst_viol, correct_all);
  return 0;
}
