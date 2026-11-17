# Bitácora

## 2026-11-16/17 (primera sesión)
- Hecho: WebCHIRP con todos los drivers de CHIRP, carga perezosa, pestañas por lectura, guardar/abrir .img, grabar con verificación, detector por barrido, alias Motorola C1, copiar canales entre modelos sin ajustes, columna "Scan", protección contra lecturas incompletas, barra de progreso al 100 %.
- TK-3407 (clon): lee y graba. Grabación del mismo respaldo verificada en el radio real.
- Canales de la red de apoyo copiados del C1 al TK-3407 (clon) con "Copiar canales a…", grabados y probados al aire por el usuario.
- Respaldos en `respaldos/`: C1 (`radiotamayoreddeapoyo.img`), TK-3407 de fábrica, Baofeng UV-5R.

## Pendiente
1. Copiar/pegar filas (Cmd+C/Cmd+V, clic derecho, deshacer) y "Desde la posición" en "Copiar canales a…": código escrito, falta correr suites `clip,copy,ui` y corregir lo que falle.
2. TK-3407: pruebas faltantes (fallo a mitad de grabación, imagen corta, progreso 100 %) y correr `rt22,verify`.
3. "Descargar detalles técnicos" solo con el último intento + botón "Copiar resumen del error".
4. C1: el bloque 0x0340 a veces llega incompleto (21 de 64 bytes); opción: verificar solo las regiones escritas.
5. Al final: Motorola MaxTrac/GM300 (linrss), ASTRO 25 solo lectura (open-astro-cps), Yaesu (radioconf).
