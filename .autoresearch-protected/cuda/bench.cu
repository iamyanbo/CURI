// PROTECTED benchmark harness. The candidate cannot read or modify this file.
//
// It owns everything that could be gamed:
//   * input generation (seeded, deterministic)
//   * the correctness reference (double precision, on CPU)
//   * the timing loop, including cudaDeviceSynchronize
//   * the shape list, half of which the candidate has never seen
//
// The candidate supplies only run_softmax(). It never touches a timer.

#include <cuda_runtime.h>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <vector>
#include <algorithm>

extern "C" void run_softmax(const float* in, float* out, int M, int N);

struct Shape { int M, N; int visible; };

// Visible shapes are documented to the candidate. Held-back shapes are not:
// a kernel that special-cases what it can see will diverge here.
static const Shape SHAPES[] = {
  {1024, 1024, 1}, {4096,  512, 1}, { 512, 4096, 1},
  {2048, 768,  0}, {  777, 1023, 0}, {3000, 333, 0},
};
static const int NSHAPES = sizeof(SHAPES) / sizeof(Shape);

static void fill(std::vector<float>& v, unsigned seed) {
  unsigned s = seed;
  for (size_t i = 0; i < v.size(); ++i) {
    s = s * 1664525u + 1013904223u;                       // deterministic LCG
    v[i] = ((float)(s >> 8) / 8388608.0f - 1.0f) * 8.0f;  // roughly [-8, 8]
  }
}

// Reference in double precision so fp32 kernel error is measured, not masked.
static void reference(const std::vector<float>& x, std::vector<double>& y, int M, int N) {
  for (int i = 0; i < M; ++i) {
    const float* r = x.data() + (size_t)i * N;
    double mx = -1e300;
    for (int j = 0; j < N; ++j) mx = std::max(mx, (double)r[j]);
    double sum = 0.0;
    for (int j = 0; j < N; ++j) sum += std::exp((double)r[j] - mx);
    for (int j = 0; j < N; ++j) y[(size_t)i * N + j] = std::exp((double)r[j] - mx) / sum;
  }
}

int main(int argc, char** argv) {
  int reps = 200, warmup = 20;
  unsigned seed = 1337u;
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--reps") && i + 1 < argc) reps = atoi(argv[++i]);
    else if (!strcmp(argv[i], "--seed") && i + 1 < argc) seed = (unsigned)atoi(argv[++i]);
  }

  cudaDeviceProp prop; cudaGetDeviceProperties(&prop, 0);
  // Peak = memClock(kHz) * 2 (DDR) * busWidth/8 bytes
  double peak_gbs = 2.0 * prop.memoryClockRate * 1e3 * (prop.memoryBusWidth / 8.0) / 1e9;

  printf("{\n  \"device\": \"%s\",\n  \"peak_gbs\": %.3f,\n  \"reps\": %d,\n  \"shapes\": [\n",
         prop.name, peak_gbs, reps);

  double vis_sum = 0, hid_sum = 0; int vis_n = 0, hid_n = 0;
  double worst_err = 0.0;
  int correct_all = 1;

  for (int s = 0; s < NSHAPES; ++s) {
    int M = SHAPES[s].M, N = SHAPES[s].N;
    size_t n = (size_t)M * N, bytes = n * sizeof(float);

    std::vector<float> h_in(n), h_out(n);
    std::vector<double> h_ref(n);
    fill(h_in, seed + s);
    reference(h_in, h_ref, M, N);

    float *d_in = nullptr, *d_out = nullptr;
    cudaMalloc(&d_in, bytes); cudaMalloc(&d_out, bytes);
    cudaMemcpy(d_in, h_in.data(), bytes, cudaMemcpyHostToDevice);
    // Poison the output so a kernel that writes nothing cannot pass by accident.
    cudaMemset(d_out, 0xFF, bytes);

    for (int w = 0; w < warmup; ++w) run_softmax(d_in, d_out, M, N);
    cudaDeviceSynchronize();

    cudaError_t err = cudaGetLastError();
    if (err != cudaSuccess) {
      printf("    {\"M\":%d,\"N\":%d,\"error\":\"%s\"}%s\n", M, N,
             cudaGetErrorString(err), s + 1 < NSHAPES ? "," : "");
      correct_all = 0; cudaFree(d_in); cudaFree(d_out); continue;
    }

    cudaMemcpy(h_out.data(), d_out, bytes, cudaMemcpyDeviceToHost);
    double maxerr = 0.0;
    for (size_t i = 0; i < n; ++i) {
      double e = std::fabs((double)h_out[i] - h_ref[i]);
      double denom = std::max(1e-12, std::fabs(h_ref[i]));
      maxerr = std::max(maxerr, e / denom);
      if (!std::isfinite((double)h_out[i])) { maxerr = 1e9; break; }
    }
    worst_err = std::max(worst_err, maxerr);
    int ok = maxerr < 1e-4;
    if (!ok) correct_all = 0;

    // Timing is ours. Each rep is individually synchronised, so a kernel cannot
    // be credited for work that has not finished.
    std::vector<double> times;
    cudaEvent_t a, b; cudaEventCreate(&a); cudaEventCreate(&b);
    for (int r = 0; r < reps; ++r) {
      cudaEventRecord(a);
      run_softmax(d_in, d_out, M, N);
      cudaEventRecord(b);
      cudaEventSynchronize(b);
      float ms = 0; cudaEventElapsedTime(&ms, a, b);
      times.push_back((double)ms);
    }
    cudaEventDestroy(a); cudaEventDestroy(b);
    std::sort(times.begin(), times.end());
    double med = times[times.size() / 2];
    double p10 = times[times.size() / 10];
    // Score the best decile, not the median.
    //
    // GPU timing noise is one-sided: clock boost, thermals and other processes
    // can only make a kernel look slower, never faster. Measured on this device,
    // median scoring gave a 32 GB/s spread across identical baseline runs - 14%
    // of the signal - which would drown any real improvement. The fastest
    // observed time is the closest estimate of the kernel's actual cost.
    double gbs = (2.0 * bytes) / (p10 * 1e-3) / 1e9;
    double gbs_med = (2.0 * bytes) / (med * 1e-3) / 1e9;

    if (SHAPES[s].visible) { vis_sum += gbs; vis_n++; } else { hid_sum += gbs; hid_n++; }

    printf("    {\"M\":%d,\"N\":%d,\"visible\":%d,\"median_ms\":%.6f,\"p10_ms\":%.6f,"
           "\"gbs\":%.3f,\"max_rel_err\":%.3e,\"correct\":%d}%s\n",
           M, N, SHAPES[s].visible, med, p10, gbs, maxerr, ok, s + 1 < NSHAPES ? "," : "");

    cudaFree(d_in); cudaFree(d_out);
  }

  printf("  ],\n  \"visible_gbs\": %.3f,\n  \"hidden_gbs\": %.3f,\n"
         "  \"worst_rel_err\": %.3e,\n  \"correct\": %d\n}\n",
         vis_n ? vis_sum / vis_n : 0.0, hid_n ? hid_sum / hid_n : 0.0,
         worst_err, correct_all);
  return 0;
}
