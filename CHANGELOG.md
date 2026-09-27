# Changelog

Todos los cambios relevantes de este proyecto se documentan aquí.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el proyecto usa
[versionado semántico](https://semver.org/lang/es/).

## [Unreleased]

### Corregido

- **Use next** ya no recomienda una sesión o cuota diaria cuando la cuota semanal de la que descuenta se
  agotará antes de su reinicio al ritmo actual: ese saldo sin usar no se pierde, y la recomendación pasa a
  la cuota que sí caducaría sin usarse.
- **Devin**: una cuota diaria agotada ya no desaparece. La API omite el 0 % restante (proto3), igual que
  ya se trataba en la semanal.

### Cambiado

- El histórico guarda una lectura repetida solo cada 5 minutos (antes, una por sondeo) y adelgaza al
  arrancar los ficheros existentes; las gráficas y sparklines se dibujan igual con ~90 % menos filas.

## [0.1.0] - 2026-09-26

Primera versión pública.

### Añadido

- Panel de terminal en vivo con la interfaz de pr-stats (Bun, OpenTUI y React): cabecera, pestañas
  numeradas, tarjetas en dos columnas, pie de atajos y la paleta original sobre fondo `#1e1e1e`.
- Proveedores **Claude**, **Codex**, **Cursor**, **Antigravity CLI** y **Devin**, que consultan
  directamente la API de cada uno con el login de su propia herramienta, sin depender de otros programas.
- Soporte de **WSL**: los logins guardados en Windows (perfil de usuario y Administrador de credenciales)
  se detectan solos.
- **Upcoming resets**: cuotas agrupadas por sesión o día, semana y mes, ordenadas por reinicio, con
  previsión al ritmo actual, cuota foco `◆` por grupo y prioridad global.
- **Línea de tiempo** con escala logarítmica (10 min a 31 días) en Upcoming resets: reinicio, punto de
  agotamiento previsto, tramo sin cuota y bloqueos por otras cuotas.
- **Previsiones**: cuándo se agotaría una cuota o qué parte quedaría sin usar al reiniciarse.
- Dependencias entre cuotas declaradas por cada proveedor, para no recomendar una cuota que otra ya
  impide usar.
- Pestaña por proveedor con cuotas en detalle, gráficas de tendencia del histórico local (6h, 24h o 7d)
  y datos extra como créditos o consumo del mes.
- Histórico local en `~/.local/share/usage-stats/history.jsonl` (14 días) y sparklines de 24 h.
- **Logos de los proveedores** como imagen real en terminales Kitty y Sixel, con un punto de color como
  alternativa. `--diagnose` y `scripts/test-graphics.sh` para comprobar el soporte gráfico.
- Modos de ejecución: `--bg` (en segundo plano con dtach, o tmux), `--wt` (panel de Windows Terminal) y
  `--wt-tab` (pestaña completa), además de `--json` para scripts.
- `scripts/install-wt-profile.sh`: perfil de Windows Terminal con IBM Plex Mono y la paleta de VS Code.
- Pausa del refresco (`p`), intervalo ajustable (`+`/`-`), refresco forzado (`R`) y repintado (`Ctrl-L`).
- Instaladores `install.sh` (Linux, macOS, WSL) e `install.ps1` (Windows) que instalan Bun si falta.
- Diseño adaptable: lista compacta por debajo de 80 columnas y pista gris sutil en todas las áreas de
  gráfico.

### Seguridad

- Los tokens solo se envían a la API oficial de su proveedor. Los tokens renovados de Claude y Codex se
  guardan de forma atómica en su fichero de origen; en los demás proveedores no se escribe nada.

[Unreleased]: https://github.com/eguijarr/usage-stats/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eguijarr/usage-stats/releases/tag/v0.1.0
