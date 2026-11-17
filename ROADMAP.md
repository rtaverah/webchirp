# Hoja de ruta (pendiente, en este orden)

Antes de usar código de cualquiera de estas fuentes hay que confirmar su licencia leyendo el archivo `LICENSE` del repositorio. Si no hay licencia, solo se usa como documentación del protocolo y se escribe un driver propio desde cero (como se hizo con el Kenwood TK-2402/3402).

1. **Motorola MaxTrac / GM300 / Radius (EXPERIMENTAL).**
   - Fuente: `vendor/linrss` (iotatron/linrss, GPLv3, compatible con este proyecto).
   - Protocolo a 949 / 7594 baudios, paquetes con nibbles +0x30 y checksum.
   - Lectura del codeplug y edición de modos.
   - Requiere RIB y un adaptador FTDI.
   - Fase 1: solo lectura, con emulador del protocolo y pruebas de fallas como las demás.

2. **Motorola ASTRO 25: XTS 2500, XTS 5000, XTS 1500 / MT1500, XTL 5000, PRC-153.**
   - Fuente: github.com/RivasMario/open-astro-cps (licencia MIT).
   - Solo lectura y respaldo: RCMP por USB CDC-ACM `0CAD:1001`, que Web Serial sí puede abrir.
   - El propio proyecto dice que la escritura no está soportada y que solo el XTS 2500 está verificado.

3. **Yaesu: github.com/cminyard/radioconf (GPL-2.0).** Prioridad baja.
   - Los modelos que soporta (FT-60R, FT-7800R, FT-897D, VX-7R y Kenwood TM-V71) ya están en CHIRP.
   - Solo sirve como referencia si algún ajuste de menú de esos modelos falla en CHIRP.
