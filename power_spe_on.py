#========power_spe_on.py Script Text=======================================================================
#  Note "#" characters in Python are comments and they can be included in the final script
#
#For Unix    systems, update the arguement in the "ser = ...." to reflect the Unix device path for the SPE
#For Windows systems, update the arguement in the "ser = ...." to reflect the COM port (e.g., COM14)
#WITHOUT any colon after the COM port name
#
#
import serial
import time
ser = serial.Serial("/dev/serial/by-id/usb-FTDI_FT232R_USB_UART_AI040V80-if00-port0")
ser.dtr = 1
ser.dtr = 0
ser.rts = 1
time.sleep(1)
ser.dtr = 1
ser.rts = 0
ser.close()
exit()
#==========================================================================================================
