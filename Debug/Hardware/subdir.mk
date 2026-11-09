################################################################################
# Automatically-generated file. Do not edit!
# Toolchain: GNU Tools for STM32 (14.3.rel1)
################################################################################

# Add inputs and outputs from these tool invocations to the build variables 
C_SRCS += \
../Hardware/DS18B20.c \
../Hardware/EdgeAI.c \
../Hardware/GPS.c \
../Hardware/IMU901.c \
../Hardware/Lora.c \
../Hardware/Motor.c \
../Hardware/Navigation.c \
../Hardware/PH.c \
../Hardware/Turbidity.c 

OBJS += \
./Hardware/DS18B20.o \
./Hardware/EdgeAI.o \
./Hardware/GPS.o \
./Hardware/IMU901.o \
./Hardware/Lora.o \
./Hardware/Motor.o \
./Hardware/Navigation.o \
./Hardware/PH.o \
./Hardware/Turbidity.o 

C_DEPS += \
./Hardware/DS18B20.d \
./Hardware/EdgeAI.d \
./Hardware/GPS.d \
./Hardware/IMU901.d \
./Hardware/Lora.d \
./Hardware/Motor.d \
./Hardware/Navigation.d \
./Hardware/PH.d \
./Hardware/Turbidity.d 


# Each subdirectory must supply rules for building sources it contributes
Hardware/%.o Hardware/%.su Hardware/%.cyclo: ../Hardware/%.c Hardware/subdir.mk
	arm-none-eabi-gcc "$<" -mcpu=cortex-m33 -std=gnu11 -g3 -DDEBUG -DUSE_HAL_DRIVER -DSTM32U5A5xx -c -I../Core/Inc -I../Drivers/STM32U5xx_HAL_Driver/Inc -I../Drivers/STM32U5xx_HAL_Driver/Inc/Legacy -I../Drivers/CMSIS/Device/ST/STM32U5xx/Include -I../Drivers/CMSIS/Include -I../Hardware -I../AI/ph -I../AI/temperature -O0 -ffunction-sections -fdata-sections -Wall -fstack-usage -fcyclomatic-complexity -MMD -MP -MF"$(@:%.o=%.d)" -MT"$@" --specs=nano.specs -mfpu=fpv5-sp-d16 -mfloat-abi=hard -mthumb -o "$@"

clean: clean-Hardware

clean-Hardware:
	-$(RM) ./Hardware/DS18B20.cyclo ./Hardware/DS18B20.d ./Hardware/DS18B20.o ./Hardware/DS18B20.su ./Hardware/EdgeAI.cyclo ./Hardware/EdgeAI.d ./Hardware/EdgeAI.o ./Hardware/EdgeAI.su ./Hardware/GPS.cyclo ./Hardware/GPS.d ./Hardware/GPS.o ./Hardware/GPS.su ./Hardware/IMU901.cyclo ./Hardware/IMU901.d ./Hardware/IMU901.o ./Hardware/IMU901.su ./Hardware/Lora.cyclo ./Hardware/Lora.d ./Hardware/Lora.o ./Hardware/Lora.su ./Hardware/Motor.cyclo ./Hardware/Motor.d ./Hardware/Motor.o ./Hardware/Motor.su ./Hardware/Navigation.cyclo ./Hardware/Navigation.d ./Hardware/Navigation.o ./Hardware/Navigation.su ./Hardware/PH.cyclo ./Hardware/PH.d ./Hardware/PH.o ./Hardware/PH.su ./Hardware/Turbidity.cyclo ./Hardware/Turbidity.d ./Hardware/Turbidity.o ./Hardware/Turbidity.su

.PHONY: clean-Hardware

