# Sustituto mínimo de pyserial para el navegador. Solo aporta las constantes
# y clases que importan los drivers; el puerto real es webchirp.WebSerial.

PARITY_NONE, PARITY_EVEN, PARITY_ODD, PARITY_MARK, PARITY_SPACE = 'N', 'E', 'O', 'M', 'S'
STOPBITS_ONE, STOPBITS_ONE_POINT_FIVE, STOPBITS_TWO = 1, 1.5, 2
FIVEBITS, SIXBITS, SEVENBITS, EIGHTBITS = 5, 6, 7, 8


class SerialException(IOError):
    pass


class SerialTimeoutException(SerialException):
    pass


class SerialBase:
    pass


class Serial(SerialBase):
    def __init__(self, *a, **k):
        raise SerialException('En la web el puerto se elige con el botón "Puerto COM"')


def serial_for_url(*a, **k):
    raise SerialException('No disponible en la web')
