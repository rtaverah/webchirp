# WebCHIRP

Versión web de [CHIRP](https://chirpmyradio.com), el programa para leer, editar y programar radios de comunicaciones. Todo corre en el navegador: los drivers originales de CHIRP (más de 500 modelos) se ejecutan con Python (Pyodide/WebAssembly) y el radio se conecta por Web Serial. No hay servidor ni instalación.

## Requisitos

- Computador con **Google Chrome o Microsoft Edge** actualizado (Web Serial y JSPI solo existen allí).
- Cable de programación del radio.
- Sin Chrome/Edge o sin puerto, igual se pueden abrir, editar y guardar archivos `.img` y `.csv`.

## Cómo se usa

1. Elige el **puerto COM**, la **marca** y el **modelo** (hay un buscador de texto) y pulsa **Leer del radio**. Cada lectura abre una **pestaña** nueva con un número (#1, #2…) y un color propio, así se distinguen radios del mismo modelo. «Abrir archivo» (o arrastrar un `.img`/`.csv`) también crea una pestaña.
2. Al terminar una lectura pregunta **«¿Guardar esta lectura en el computador?»**. Esa copia es el respaldo del radio: guárdala antes de grabar.
3. Edita las memorias y los ajustes. La columna **Scan** muestra Sí/No/Prioridad (internamente sigue siendo vacío/`S`/`P` de CHIRP).
4. **Grabar #N en el radio** graba la pestaña seleccionada. Después de escribir, WebCHIRP vuelve a leer el radio y compara canal por canal y byte por byte. Solo dice **«✓ Quedó bien grabado»** si todo coincide; si no, avisa y ofrece los detalles. Si no se pudo comprobar, ofrece «Comprobar de nuevo».
5. **Copiar canales a…** copia solo los canales (no los ajustes) de una pestaña a una lectura real de otro radio, aunque sea de otro modelo, usando la lógica de importación de CHIRP. El resultado es una pestaña nueva; las originales no se modifican. También se pueden marcar filas y copiar solo esas.
6. **Detectar radio (barrido)** prueba los protocolos uno por uno, solo leyendo (nunca escribe), para radios desconocidos.

Si una operación pasa de 20 s sin progreso aparece «El radio no responde todavía… [Cancelar]». Durante una lectura o grabación la pestaña del navegador debe estar visible.

## Aviso de responsabilidad

WebCHIRP se ofrece tal cual, sin garantía. Programar un radio puede borrar su configuración o dejarlo inutilizable si se interrumpe la grabación, se usa el modelo equivocado o el cable falla. Haz siempre una copia de seguridad. Los autores no se hacen responsables de daños, pérdida de datos ni del uso de frecuencias no autorizadas.

## Correrlo en local

```sh
python3 -m http.server 8765 --directory webchirp
```

Abre http://localhost:8765. Web Serial funciona en `localhost` sin HTTPS. El motor (Pyodide + `chirp.zip`) se descarga en segundo plano y los drivers se cargan **solo cuando se elige o abre un modelo** (carga perezosa): la página es usable en una fracción de segundo y el driver de un modelo tarda cerca de 0,15 s en cargarse (todos juntos, unos 4–6 s).

## Archivos de datos

- `models.json`: índice estático de modelos (marca, modelo, variante y módulo del driver). Permite llenar Marca/Modelo sin esperar al motor. **Hay que regenerarlo después de cada `./build.sh`**: abre `tools/build-index.html` en el navegador y pulsa «Descargar models.json» (se genera en el navegador porque CHIRP exige Python ≥ 3.10).
- `aliases.json`: alias verificados en campo. Cada entrada nombra un modelo que usa el driver de otro, sin tocar código:

  ```json
  [{"vendor": "Motorola", "model": "C1", "target": "LUITON_LT-316",
    "note": "Verificado con radio real (lectura) — 2026-11-17"}]
  ```

  `target` es el `id` del driver en `models.json`. El alias aparece en la lista de marcas y se carga el mismo módulo; la etiqueta dice «Motorola C1 (compatible con LUITON LT-316)». El `.img` guardado conserva los metadatos reales del driver, así sigue siendo compatible con CHIRP de escritorio.

## Drivers propios (no vienen de CHIRP)

En `py/drivers_extra/`. Son **experimentales**:

- **Kenwood TK-2402 (VHF) y TK-3402 (UHF)**: fase 1, **solo lectura**. La lectura guarda toda la EEPROM (0x0000–0x1FFF), así que el archivo sirve de respaldo. La grabación está desactivada hasta confirmar el mapa de memoria con una lectura real. Soporta cables de un solo hilo con eco (KPG-22) y las dos variantes del saludo (0x16 con cambio a 19200 baudios, o 0x06 directo). Implementación propia a partir de los hechos del protocolo, sin copiar código.
- **Kenwood TK-3407 (clon)**: **experimental, lee y graba**. Para radios chinos vendidos como Kenwood TK-3407 que por dentro son de la familia Retevis RT22 / LUITON LT-316 (responden «P32073» y solo aceptan el saludo «PROGRAM»). Saludo tolerante al ruido del cable; la lectura usa el protocolo RT22 de CHIRP y siempre manda la salida «E» para liberar el radio. Graba con el mismo formato de CHIRP (bloques «W» de las regiones de `_ranges`, 06 por bloque); antes de grabar exige imagen completa con identidad P3207x en 0x1B8, y si el primer bloque no recibe 06 se detiene tras un solo reintento con el paso 07. Haga siempre un respaldo leyendo antes. Si se elige el TK-2402/3402 con uno de estos radios, avisa que hay que elegir este modelo.

Ver `ROADMAP.md` para lo que sigue.

## Actualizar los drivers de CHIRP

`chirp.zip` contiene el código de CHIRP sin la interfaz gráfica:

```sh
./build.sh /ruta/al/codigo/de/chirp     # sin argumento usa ../vendor/chirp-src
```

Después regenera `models.json` (ver arriba).

## Publicarlo

Es un sitio estático (sin build). Copia a cualquier hosting estático (GitHub Pages, Netlify, Cloudflare Pages, Nginx…) **solo esto**:

```
index.html  css/  js/  py/  chirp.zip  models.json  aliases.json  COPYING
```

**No subas** `tests/` (ni `tests/fixtures/`, que pesa ~12 MB de imágenes), `tools/`, `samples/` ni ningún `.img`; el `.gitignore` ya los excluye del repositorio. Debe servirse por **HTTPS**, porque Web Serial no funciona en HTTP (excepto `localhost`).

## Pruebas

Todo lo de `tests/` corre en Chrome, sin radio, con emuladores del protocolo (UV-5R, BF-888, RT22/LT-316, Kenwood TK-2402/3402, Icom y los de CHIRP) y un puerto Web Serial simulado que trocea las respuestas e inyecta fallas.

```sh
./tests/prepare.sh                      # copia imágenes y tests de CHIRP a tests/fixtures (una vez)
python3 tests/serve.py 8766 /tmp/resultados.jsonl
# abre http://localhost:8766/tests/index.html (botones por grupo) o ?auto=emu,verify,rt22,settle,tk,copy,ui,scan,alias,faults,chirp
```

También desde la consola: `await runSuite('faults')`. Las suites con temporizadores (`rt22`, `settle`, `tk`, `ui`, `scan`) se deben correr en **tiempo real** (ventana visible o headless sin `--virtual-time-budget`); los timers de una pestaña oculta se frenan.

## Estructura

- `index.html`, `css/styles.css`, `js/app.js`: interfaz.
- `js/engine.js`: carga Pyodide y los drivers; API en JavaScript. `js/serial-bridge.js`: puente Web Serial.
- `py/webchirp.py`: capa Python sobre los drivers de CHIRP (pestañas, verificación, barrido, copiar canales).
- `py/drivers_extra/`: drivers propios. `tools/build-index.html`: genera `models.json`.
- `tests/`: pruebas (no se publican).

## Licencia

GPLv3, igual que CHIRP. Basado en CHIRP (chirpmyradio.com). Ver `COPYING`.
