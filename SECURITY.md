# Revisión de privacidad y seguridad

Revisión local realizada el 27 de septiembre de 2026. Se revisaron el código, instaladores,
lanzadores, salidas de terminal y JSON, histórico, recursos gráficos y el historial de Git disponible.
Las pruebas utilizan credenciales ficticias; no se consultaron las APIs con tokens reales.

## Resultado del análisis

No se encontraron tokens personales activos, claves privadas, archivos de login ni correos privados
de usuario incorporados al proyecto. Se analizaron archivos actuales, commits y objetos locales de
Git, incluidos los que no pertenecen a las referencias actuales. Los correos de autor examinados
usan `noreply.github.com`; Git y los enlaces mantienen alias públicos y atribuciones de terceros.

Gitleaks 8.24.3 se verificó mediante el checksum de la distribución oficial y un control positivo con
una credencial sintética. El análisis del historial detectó un JWT de ejemplo en una antigua prueba
de `src/privacy.test.ts`: contiene un sujeto de demostración, sin emisor ni audiencia de proveedor,
y no es una credencial de una cuenta. La prueba actual genera el ejemplo durante su ejecución.
Este hallazgo no se ocultó con una exclusión general de los tests.

La constante OAuth de Antigravity coincide con la distribuida en el
[plugin original de CrossUsage](https://github.com/barramee27/crossusage/blob/feat/linux-windows-native-support/plugins/antigravity-cli/plugin.js).
Identifica al cliente instalado, no a una cuenta personal. La distinción entre un cliente instalado
y los tokens del usuario se explica en la
[documentación de Google](https://developers.google.com/identity/protocols/oauth2/native-app).

Los PNG actuales no contienen bloques EXIF ni metadatos de texto. La vista previa del README se
regeneró desde fixtures ficticios con la marca DEMO, sin abrir sesiones ni cargar históricos reales.
La ilustración del banner no contiene tokens ni identificadores personales legibles.

## Vías de exposición corregidas

| Vía | Protección aplicada |
|---|---|
| Excepciones que mostraban rutas o detalles internos | Mensajes públicos controlados en sondeos, JSON, arranque y errores del histórico. |
| Campos de cuenta o credenciales en respuestas | Exportación por lista de campos; filtrado de textos y ocultación exacta de credenciales conocidas. |
| Redirecciones de peticiones autenticadas | `redirect: 'error'`, HTTPS y lista explícita de destinos; Devin solo permite su servidor oficial. |
| Histórico legible por otros usuarios | Archivo `0600` y directorio de la aplicación `0700` en sistemas POSIX; rechazo de enlaces simbólicos. |
| Temporales de credenciales | Creación exclusiva, nombre aleatorio, permiso `0600` y limpieza si falla la escritura. |
| Tokens de Claude en argumentos de macOS | Actualización del Keychain por stdin, fuera de los argumentos del proceso. |
| Datos del entorno en diagnóstico | Se ocultan identificadores de sesión, ruta de tmux y nombre de distribución WSL. |
| Rutas personales en mensajes de instalación | Los mensajes propios no imprimen la ruta del proyecto ni del perfil de Windows. |
| Socket de segundo plano | Directorio propio de permiso `0700`, comprobación de propietario y máscara `077`. |
| Inclusión accidental de datos locales en Git | Exclusiones para logins, `.env`, claves, bases de estado, histórico y logs. |
| Captura pública de uso | Imagen de demostración reproducible mediante `bun run preview`. |

## Comprobaciones

- Pruebas de JSON de la aplicación completa: mantienen cuotas y rechazan identidades y credenciales
  añadidas a respuestas o errores simulados.
- Redirección HTTP 307 con un servidor local: el cuerpo autenticado no se reenvía al segundo destino.
- Rechazo de hosts no permitidos, HTTP, credenciales en URL y puertos personalizados antes de enviar.
- Pruebas de permisos, histórico existente, campos adicionales, enlaces y limpieza de temporales.
- Contrato del helper de macOS: la credencial se transmite por stdin y no aparece en los argumentos;
  se rechazan entradas que podrían romper el parser o superar su límite de 4096 bytes.
- Verificación de tipos, suite completa y sintaxis de los scripts de Bash.
- Suite final: 72 pruebas correctas, sin fallos; comprobación TypeScript sin errores.

## Alcance y límites

Esta revisión no garantiza que cualquier dato imaginable se pueda reconocer mediante expresiones
regulares. La protección principal es no exportar perfiles ni respuestas completas, usar campos
concretos de cuota y descartar detalles de excepciones inesperadas; la redacción es una protección
adicional. Las credenciales deben existir en memoria y se envían a su proveedor para autenticar las
consultas. El histórico y la pantalla contienen información de uso: cuotas, planes y saldos.

Las pruebas se ejecutaron en Linux/WSL. El Keychain real de macOS y las ACL de Windows nativo no se
verificaron en esos sistemas; se comprobó el contrato del helper de macOS con una simulación. Los
permisos POSIX no sustituyen a las ACL de Windows ni protegen frente a procesos del mismo usuario o
administradores del equipo. Tampoco se auditó íntegramente el código de las dependencias externas.

Se revisó el repositorio local y su historial disponible, no otros repositorios, forks o copias ya
distribuidas. Las capturas antiguas en commits previos pueden conservar datos de consumo: corregir
el archivo actual no modifica esas versiones. La revisión no reescribe ni elimina commits.
