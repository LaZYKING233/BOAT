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

  /* 诊断用：NanoEdge 各调用的返回码。
   * 相似度恒为 0 时无法区分"模型没初始化成功"和"输入严重偏离训练分布"，
   * 而这两种原因的处理方式完全相反，所以把返回码一并上报。 */
  int8_t  ph_init_state;
  int8_t  ph_detect_state;
  int8_t  temperature_init_state;
  int8_t  temperature_detect_state;
} EdgeAI_Status_t;

void EdgeAI_Init(void);
void EdgeAI_UpdatePh(int32_t ph_x100, uint32_t ph_raw, uint32_t ph_mv);
void EdgeAI_UpdateTemperature(int32_t temp_x100, uint8_t temp_valid);
EdgeAI_Status_t EdgeAI_GetStatus(void);

#ifdef __cplusplus
}
#endif

#endif /* EDGE_AI_H */
