# WebCHIRP — memoria del proyecto

Programa web (Chrome/Edge) para leer y grabar radios por el puerto COM, basado en CHIRP (GPLv3) corriendo en Pyodide. Detalles técnicos: `webchirp/README.md`. Historial de trabajo: `docs/bitacora.md` (leerla al empezar; añadir 2-3 líneas al terminar cada tarea).

El usuario habla español; respóndele en español, de "usted", sin jerga.

## Cómo se reparte el trabajo (ahorrar tokens)
- Una conversación por tarea corta. Al terminar: anotar en la bitácora y cerrar.
- Modelo por defecto: **Sonnet**, que programa directo (sin subagentes para tareas pequeñas).
- **Explore (Haiku)**: solo para buscar en muchos archivos o entender una parte grande del código. Para leer 1-2 archivos, leer directo.
- **Avisar al usuario antes de seguir** cuando algo se complique: un radio que no responde y la causa no está clara, dos intentos fallidos seguidos, un protocolo de radio nuevo, o riesgo de dañar un radio. Darle 2-3 alternativas con su costo y decir si conviene cambiar a Opus. Él decide.
- Pruebas: solo la suite del tema tocado, una vez, la corre quien programa. Suites completas solo al cierre del día.
- Registros del usuario: pedir solo el último intento (no el historial completo).

## Reglas que no se cambian
- Aviso de responsabilidad y pie "Basado en CHIRP · GPLv3": no se tocan.
- Solo la clase BF-888 tiene el desbloqueo VHF+UHF.
- Siempre leer y guardar respaldo (.img) antes de grabar; grabar verifica releyendo ("✓ Quedó bien grabado").
- Lecturas incompletas: no se crea pestaña; imágenes incompletas: no se graban.
- El detector (barrido) nunca graba.
- Respetar licencias: `vendor/tk2402` NO tiene licencia (solo referencia de protocolo, no copiar código). No abrir ni ejecutar el `.rar` de KPG.
- No usar el puerto 8765 en pruebas: es el servidor del usuario (`python3 -m http.server 8765 --directory webchirp`).

## Radios y hallazgos
- Motorola C1 = alias de LUITON LT-316 (familia Retevis RT22 / WLN KD-C1). Saludo "PROGRGS". Canales 1-3 del respaldo son la red de apoyo; el resto, de fábrica del KD-C1.
- "Kenwood TK-3407" del usuario es un clon chino de la familia RT22: saludo "PROGRAM" (50 ms entre bytes), identidad `P32073 F8 FF`, sin paso 07. Driver propio `py/drivers_extra/kenwood_tk3407_clone.py` (lee y graba; grabación probada en el radio real el 2026-11-17).
- Kenwood TK-2402/3402 originales: driver experimental `kenwood_tk2402.py` (clean-room). Si la identidad empieza por "P3207", libera el radio y sugiere TK-3407 (clon).
- El ruido 1C/E0 al abrir el puerto es audio del cable cuando el radio no está en programación: se descarta, no es error.
- Cable del usuario: CH340 (USB 1A86:7523).

## Pendiente
Ver `docs/bitacora.md`.
