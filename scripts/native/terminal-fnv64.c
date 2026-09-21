#include <stdint.h>

/* Private scratch is consumed synchronously; callers retain their own state. */
static unsigned char scratch[4096];

uint32_t scratch_ptr(void) {
  return (uint32_t)(uintptr_t)scratch;
}

uint64_t update(uint64_t state, uint32_t length) {
  for (uint32_t i = 0; i < length; ++i) {
    state = (state ^ scratch[i]) * UINT64_C(1099511628211);
  }
  return state;
}
