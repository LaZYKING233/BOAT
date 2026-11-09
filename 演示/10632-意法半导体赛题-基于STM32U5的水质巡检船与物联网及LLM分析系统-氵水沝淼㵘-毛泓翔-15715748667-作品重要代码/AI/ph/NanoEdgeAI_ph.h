/*
 * Prefixed NanoEdge AI header for the pH anomaly detection model.
 * Original model package: AI/[h.zip
 */
#ifndef NANOEDGEAI_PH_H
#define NANOEDGEAI_PH_H

#include <stdint.h>
#include <stdbool.h>

#define PH_NEAI_ID "6a37e2a3cb8746ef76cfe572"
#define PH_NEAI_INPUT_SIGNAL_LENGTH 1
#define PH_NEAI_INPUT_AXIS_NUMBER 5

#define PH_NEAI_OK 0
#define PH_NEAI_ERROR 1
#define PH_NEAI_NOT_INITIALIZED 2
#define PH_NEAI_INVALID_PARAM 3
#define PH_NEAI_NOT_SUPPORTED 4
#define PH_NEAI_LEARNING_DONE 5
#define PH_NEAI_LEARNING_IN_PROGRESS 6

typedef int ph_neai_state_t;

#ifdef __cplusplus
extern "C" {
#endif

ph_neai_state_t ph_neai_anomalydetection_init(bool use_pretrained);
ph_neai_state_t ph_neai_anomalydetection_learn(float *in);
ph_neai_state_t ph_neai_anomalydetection_detect(float *in, uint8_t *similarity);
char *ph_neai_get_id(void);
int ph_neai_get_input_signal_size(void);
int ph_neai_get_axis_number(void);

#ifdef __cplusplus
}
#endif

#endif /* NANOEDGEAI_PH_H */
