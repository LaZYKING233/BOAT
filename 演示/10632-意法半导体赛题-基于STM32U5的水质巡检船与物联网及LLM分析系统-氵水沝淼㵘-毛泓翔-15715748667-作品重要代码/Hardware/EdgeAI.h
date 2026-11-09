#ifndef EDGE_AI_H
#define EDGE_AI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define EDGE_AI_PH_NORMAL_THRESHOLD           80U
#define EDGE_AI_TEMPERATURE_NORMAL_THRESHOLD 80U

typedef struct {
  uint8_t ph_similarity;
  uint8_t ph_normal;
  uint8_t temperature_similarity;
  uint8_t temperature_normal;
  uint8_t initialized;
} EdgeAI_Status_t;

void EdgeAI_Init(void);
void EdgeAI_UpdatePh(int32_t ph_x100, uint32_t ph_raw, uint32_t ph_mv);
void EdgeAI_UpdateTemperature(int32_t temp_x100, uint8_t temp_valid);
EdgeAI_Status_t EdgeAI_GetStatus(void);

#ifdef __cplusplus
}
#endif

#endif /* EDGE_AI_H */
