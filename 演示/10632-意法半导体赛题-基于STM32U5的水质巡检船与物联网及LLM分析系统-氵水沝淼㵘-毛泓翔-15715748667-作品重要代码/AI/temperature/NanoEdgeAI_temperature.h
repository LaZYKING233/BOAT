/*
 * Prefixed NanoEdge AI header for the temperature anomaly detection model.
 * Original model package: AI/tem.zip
 */
#ifndef NANOEDGEAI_TEMPERATURE_H
#define NANOEDGEAI_TEMPERATURE_H

#include <stdint.h>
#include <stdbool.h>

#define TEMPERATURE_NEAI_ID "6a38aa09cb8746ef76cfe978"
#define TEMPERATURE_NEAI_INPUT_SIGNAL_LENGTH 1
#define TEMPERATURE_NEAI_INPUT_AXIS_NUMBER 3

#define TEMPERATURE_NEAI_OK 0
#define TEMPERATURE_NEAI_ERROR 1
#define TEMPERATURE_NEAI_NOT_INITIALIZED 2
#define TEMPERATURE_NEAI_INVALID_PARAM 3
#define TEMPERATURE_NEAI_NOT_SUPPORTED 4
#define TEMPERATURE_NEAI_LEARNING_DONE 5
#define TEMPERATURE_NEAI_LEARNING_IN_PROGRESS 6

typedef int temperature_neai_state_t;

#ifdef __cplusplus
extern "C" {
#endif

temperature_neai_state_t temperature_neai_anomalydetection_init(bool use_pretrained);
temperature_neai_state_t temperature_neai_anomalydetection_learn(float *in);
temperature_neai_state_t temperature_neai_anomalydetection_detect(float *in, uint8_t *similarity);
char *temperature_neai_get_id(void);
int temperature_neai_get_input_signal_size(void);
int temperature_neai_get_axis_number(void);

#ifdef __cplusplus
}
#endif

#endif /* NANOEDGEAI_TEMPERATURE_H */
