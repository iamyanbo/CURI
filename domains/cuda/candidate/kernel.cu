// CANDIDATE FILE — this is what you optimise.
//
// Task: row-wise softmax over an M x N fp32 matrix, out[i][j] = exp(x-max)/sum.
//
// Contract (enforced outside this file):
//   * You MUST keep the exact signature of run_softmax below.
//   * The timing harness lives in protected code you cannot read or edit. It
//     synchronises the device itself, so you cannot win by skipping a sync.
//   * Correctness is checked against a double-precision CPU reference on shapes
//     you have never seen. Producing wrong results quickly is not a speedup.
//   * The benchmark also runs held-back shapes, so special-casing the visible
//     ones is detected.
//
// This baseline is deliberately naive: three full passes over memory (max, sum,
// normalise) plus a fourth read. It moves ~4x the bytes it needs to.
// A perfect kernel reads the input once and writes the output once.
//
// Roofline on this device: 448 GB/s. A kernel reporting more than that is not
// doing the work.

#include <cuda_runtime.h>
#include <cfloat>

#ifndef BLOCK_SIZE
#define BLOCK_SIZE 256
#endif

__global__ void softmax_naive(const float* __restrict__ in,
                              float* __restrict__ out,
                              int M, int N) {
  int row = blockIdx.x;
  if (row >= M) return;
  const float* x = in + (size_t)row * N;
  float* y = out + (size_t)row * N;

  __shared__ float shared[BLOCK_SIZE];
  int tid = threadIdx.x;

  // pass 1: row max
  float m = -FLT_MAX;
  for (int j = tid; j < N; j += BLOCK_SIZE) m = fmaxf(m, x[j]);
  shared[tid] = m;
  __syncthreads();
  for (int s = BLOCK_SIZE / 2; s > 0; s >>= 1) {
    if (tid < s) shared[tid] = fmaxf(shared[tid], shared[tid + s]);
    __syncthreads();
  }
  float rowmax = shared[0];
  __syncthreads();

  // pass 2: sum of exp
  float sum = 0.0f;
  for (int j = tid; j < N; j += BLOCK_SIZE) sum += __expf(x[j] - rowmax);
  shared[tid] = sum;
  __syncthreads();
  for (int s = BLOCK_SIZE / 2; s > 0; s >>= 1) {
    if (tid < s) shared[tid] += shared[tid + s];
    __syncthreads();
  }
  float rowsum = shared[0];
  __syncthreads();

  // pass 3: normalise
  float inv = 1.0f / rowsum;
  for (int j = tid; j < N; j += BLOCK_SIZE) y[j] = __expf(x[j] - rowmax) * inv;
}

extern "C" void run_softmax(const float* in, float* out, int M, int N) {
  softmax_naive<<<M, BLOCK_SIZE>>>(in, out, M, N);
}
