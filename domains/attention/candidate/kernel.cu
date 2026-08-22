// CANDIDATE FILE — this is what you optimise.
//
// Task: fused multi-head attention.
//   O[b,h,i,:] = softmax_i( Q[b,h,i,:] . K[b,h,:,:]^T / sqrt(D) ) . V[b,h,:,:]
// for every batch b, head h. Q, K, V, O are fp32, contiguous tensors with
// layout [B][H][T][D] (i.e. the (b,h) pair is the leading contiguous dim,
// then token, then head-dimension).
//
// Contract (enforced outside this file):
//   * You MUST keep the exact signature of run_attention below, on one line.
//   * The timing harness lives in protected code you cannot read or edit. It
//     synchronises the device itself, so you cannot win by skipping a sync.
//   * Correctness is checked against a double-precision CPU reference on
//     shapes you have never seen. Producing wrong results quickly is not a
//     speedup.
//   * Half the benchmark shapes are held back from you; special-casing the
//     visible ones is detected by the protected harness.
//
// Metric: achieved TFLOP/s = 4*B*H*T*T*D / elapsed. Each of the two matmuls
// (QK^T and the softmax-weighted PV) contributes 2*B*H*T*T*D flops.
//
// This baseline is deliberately naive: for every head it materialises the full
// T*T score matrix in global memory, softmaxes that matrix in place, and only
// then runs the PV matmul. It writes the score matrix once and reads it four
// more times. A proper fused kernel (flash-attention style) tiles Q,K,V and
// uses online softmax, reads Q,K,V and writes O exactly once, and never
// touches global memory for scores.

#include <cuda_runtime.h>
#include <cfloat>

#ifndef BLOCK_SIZE
#define BLOCK_SIZE 256
#endif

// scores[i][j] = dot(Q[i], K[j]) / sqrt(D) — one block per (head, row i).
__global__ void mha_qk_scores(const float* __restrict__ Q,
                              const float* __restrict__ K,
                              float* __restrict__ S,
                              int heads, int T, int D) {
  const int block = blockIdx.x;
  const int head = block / T;
  const int i = block % T;
  const float* q = Q + (size_t)head * T * D + (size_t)i * D;
  const float* kbase = K + (size_t)head * T * D;
  float* srow = S + (size_t)head * T * T + (size_t)i * T;
  const float scale = 1.0f / sqrtf((float)D);
  for (int j = threadIdx.x; j < T; j += blockDim.x) {
    const float* k = kbase + (size_t)j * D;
    float acc = 0.0f;
    for (int d = 0; d < D; ++d) acc += q[d] * k[d];
    srow[j] = acc * scale;
  }
}

// Row-wise softmax, in place. Three passes over S per row.
__global__ void mha_softmax(float* __restrict__ S, int heads, int T) {
  const int block = blockIdx.x;
  const int head = block / T;
  const int i = block % T;
  float* s = S + (size_t)head * T * T + (size_t)i * T;

  __shared__ float sh[BLOCK_SIZE];

  float m = -FLT_MAX;
  for (int j = threadIdx.x; j < T; j += blockDim.x) m = fmaxf(m, s[j]);
  sh[threadIdx.x] = m;
  __syncthreads();
  for (int off = blockDim.x / 2; off > 0; off >>= 1) {
    if (threadIdx.x < off) sh[threadIdx.x] = fmaxf(sh[threadIdx.x], sh[threadIdx.x + off]);
    __syncthreads();
  }
  m = sh[0];
  __syncthreads();

  float sum = 0.0f;
  for (int j = threadIdx.x; j < T; j += blockDim.x) { s[j] = expf(s[j] - m); sum += s[j]; }
  sh[threadIdx.x] = sum;
  __syncthreads();
  for (int off = blockDim.x / 2; off > 0; off >>= 1) {
    if (threadIdx.x < off) sh[threadIdx.x] += sh[threadIdx.x + off];
    __syncthreads();
  }
  const float inv = 1.0f / sh[0];
  __syncthreads();
  for (int j = threadIdx.x; j < T; j += blockDim.x) s[j] *= inv;
}

// O[i,d] = sum_j S[i,j] * V[j,d] — one block per (head, row i).
__global__ void mha_pv(const float* __restrict__ S,
                       const float* __restrict__ V,
                       float* __restrict__ O,
                       int heads, int T, int D) {
  const int block = blockIdx.x;
  const int head = block / T;
  const int i = block % T;
  const float* srow = S + (size_t)head * T * T + (size_t)i * T;
  const float* vbase = V + (size_t)head * T * D;
  float* orow = O + (size_t)head * T * D + (size_t)i * D;
  for (int d = threadIdx.x; d < D; d += blockDim.x) {
    float acc = 0.0f;
    for (int j = 0; j < T; ++j) acc += srow[j] * vbase[(size_t)j * D + d];
    orow[d] = acc;
  }
}

extern "C" void run_attention(const float* Q, const float* K, const float* V, float* O, int B, int H, int T, int D) {
  const size_t heads = (size_t)B * H;
  const size_t scores_bytes = heads * (size_t)T * T * sizeof(float);
  // Reusable scratch for the T*T score matrices. Allocated once, grown as needed.
  static float* scratch = nullptr;
  static size_t scratch_cap = 0;
  if (scratch && scores_bytes > scratch_cap) {
    cudaFree(scratch);
    scratch = nullptr;
    scratch_cap = 0;
  }
  if (!scratch) {
    if (cudaMalloc(&scratch, scores_bytes) != cudaSuccess) return;
    scratch_cap = scores_bytes;
  }
  const int grid = (int)(heads * T);
  mha_qk_scores<<<grid, BLOCK_SIZE>>>(Q, K, scratch, (int)heads, T, D);
  mha_softmax<<<grid, BLOCK_SIZE>>>(scratch, (int)heads, T);
  mha_pv<<<grid, BLOCK_SIZE>>>(scratch, V, O, (int)heads, T, D);
}
