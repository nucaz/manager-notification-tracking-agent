---
name: ejs-atributos-sin-escapar
description: 'Usar al escribir una plantilla EJS (`views/**/*.ejs`) donde un atributo HTML (maxlength, pattern, placeholder, disabled, etc.) se arma condicionalmente como un string con comillas dentro de codigo EJS, en vez de ser un valor simple. Ejemplos - "agrega un maxlength que dependa de X", "si Y entonces agrega este atributo al input", cualquier `<%= condicion ? "attr=\"valor\"" : "" %>` o similar. Tambien util como checklist rapido al revisar por que un atributo HTML "no se aplica" en el navegador pese a estar en el codigo fuente de la plantilla.'
---

# EJS: `<%- %>` para atributos HTML ya armados, nunca `<%= %>`

## El bug real que motivo esta skill

En `views/mobileDevices/form.ejs` se armo el `maxlength` del numero de
telefono dinamicamente segun el pais elegido:

```ejs
<input ... <%= selectedCountry ? 'maxlength="' + selectedCountry.mobile_length + '" placeholder="..."' : '' %>>
```

`<%= %>` en EJS **escapa HTML** (convierte `"` en `&#34;`, entre otras
cosas) — es el comportamiento correcto para imprimir texto de usuario
dentro del cuerpo de la pagina (evita XSS), pero rompe por completo un
string que ya es HTML valido por si mismo. El resultado renderizado fue:

```html
<input ... maxlength=&#34;9&#34; placeholder=&#34;9 dígitos&#34;>
```

Eso **no es un atributo `maxlength` valido** — el navegador lo ignora
silenciosamente. No hubo ningun error visible: el campo simplemente
aceptaba cualquier cantidad de caracteres, como si el limite no
existiera. Se detecto porque el usuario probo el formulario a mano
escribiendo un numero larguisimo, no por inspeccion de codigo ni por un
test automatizado.

## Regla

- **`<%= valor %>`**: para imprimir CONTENIDO (texto que va entre
  etiquetas, o el VALOR de un atributo ya delimitado por comillas
  fijas en la plantilla, ej. `value="<%= item.foo %>"`). Escapa HTML a
  proposito.
- **`<%- html %>`**: para imprimir HTML/atributos YA construidos como
  string, que no deben escaparse. Usar solo cuando el contenido del
  string es HTML confiable generado por el propio codigo del servidor
  (nunca con texto libre de un usuario sin sanitizar antes).

## Como detectarlo al revisar una plantilla

Buscar el patron `<%= condicion ? '...="...' : '...' %>` (una
expresion ternaria que arma un string con comillas dobles/simples
literales adentro, usada directamente como atributo HTML) — si usa
`<%=` en vez de `<%-`, es casi seguro el mismo bug. Verificarlo
renderizando la plantilla real con datos de muestra (no solo
`ejs.compile`, que solo valida sintaxis, no el HTML resultante) e
inspeccionando el HTML generado:

```js
const html = ejs.render(fs.readFileSync('views/x.ejs','utf8'), { ...datosDeMuestra }, { filename: 'views/x.ejs' });
console.log(html); // buscar &#34; o &amp;quot; donde deberia haber comillas de atributo
```

## Por que no se detecto antes

`node -c` (sintaxis JS) y `ejs.compile()` (sintaxis de plantilla) pasan
sin error los dos casos — el bug es semantico (que HTML termina
produciendo), no sintactico. La unica forma de atraparlo es
renderizar con datos reales e inspeccionar el HTML de salida, o probar
el campo a mano en el navegador.
