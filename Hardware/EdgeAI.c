#include "EdgeAI.h"

#include <math.h>
#include <stdbool.h>

#include "../AI/ph/NanoEdgeAI_ph.h"
#include "../AI/temperature/NanoEdgeAI_temperature.h"

static EdgeAI_Status_t edge_ai_status = {0};
static uint8_t ph_initialized = 0U;
static uint8_t temperature_initialized = 0U;
static uint8_t ph_has_previous = 0U;
static uint8_t temperature_has_previous = 0U;
static float previous_ph = 0.0f;
static float previous_ph_mv = 0.0f;
static float previous_temperature = 0.0f;

float __hardfp_acosf(float value)
{
  return acosf(value);
}

void EdgeAI_Init(void)
{
  ph_neai_state_t ph_state;
  temperature_neai_state_t temperature_state;

  ph_state = ph_neai_anomalydetection_init(true);
  temperature_state = temperature_neai_anomalydetection_init(true);

  ph_initialized = (ph_state == PH_NEAI_OK) ? 1U : 0U;
  temperature_initialized = (temperature_state == TEMPERATURE_NEAI_OK) ? 1U : 0U;

  edge_ai_status.ph_similarity = 0U;
  edge_ai_status.ph_normal = 0U;
  edge_ai_status.temperature_similarity = 0U;
  edge_ai_status.temperature_normal = 0U;
  edge_ai_status.initialized = (ph_initialized && temperature_initialized) ? 1U : 0U;
}

void EdgeAI_UpdatePh(int32_t ph_x100, uint32_t ph_raw, uint32_t ph_mv)
{
  float ph;
  float mv;
  float ph_delta;
  float mv_delta;
  float input_signal[PH_NEAI_INPUT_SIGNAL_LENGTH * PH_NEAI_INPUT_AXIS_NUMBER];
  uint8_t similarity = 0U;

  if (!ph_initialized)
  {
    return;
  }

  ph = (float)ph_x100 / 100.0f;
  mv = (float)ph_mv;
  ph_delta = ph_has_previous ? (ph - previous_ph) : 0.0f;
  mv_delta = ph_has_previous ? (mv - previous_ph_mv) : 0.0f;

  input_signal[0] = (float)ph_raw;
  input_signal[1] = mv;
  input_signal[2] = ph;
  input_signal[3] = ph_delta;
  input_signal[4] = mv_delta;

  if (ph_neai_anomalydetection_detect(input_signal, &similarity) == PH_NEAI_OK)
  {
    edge_ai_status.ph_similarity = similarity;
    edge_ai_status.ph_normal = (similarity >= EDGE_AI_PH_NORMAL_THRESHOLD) ? 1U : 0U;
  }

  previous_ph = ph;
  previous_ph_mv = mv;
  ph_has_previous = 1U;
}

void EdgeAI_UpdateTemperature(int32_t temp_x100, uint8_t temp_valid)
{
  float temperature;
  float temperature_delta;
  float input_signal[TEMPERATURE_NEAI_INPUT_SIGNAL_LENGTH * TEMPERATURE_NEAI_INPUT_AXIS_NUMBER];
  uint8_t similarity = 0U;

  if (!temperature_initialized)
  {
    return;
  }

  temperature = temp_valid ? ((float)temp_x100 / 100.0f) : 0.0f;
  temperature_delta = temperature_has_previous ? (temperature - previous_temperature) : 0.0f;

  input_signal[0] = temperature;
  input_signal[1] = (float)temp_valid;
  input_signal[2] = temperature_delta;

  if (temperature_neai_anomalydetection_detect(input_signal, &similarity) == TEMPERATURE_NEAI_OK)
  {
    edge_ai_status.temperature_similarity = similarity;
    edge_ai_status.temperature_normal = (similarity >= EDGE_AI_TEMPERATURE_NORMAL_THRESHOLD) ? 1U : 0U;
  }

  previous_temperature = temperature;
  temperature_has_previous = 1U;
}

EdgeAI_Status_t EdgeAI_GetStatus(void)
{
  return edge_ai_status;
}
