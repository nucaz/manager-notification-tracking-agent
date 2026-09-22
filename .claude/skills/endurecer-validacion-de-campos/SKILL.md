---
name: endurecer-validacion-de-campos
description: 'Usar al agregar o endurecer la validacion de un campo existente (tamano maximo, formato alfanumerico/numerico/decimal, patron obligatorio) en un formulario o columna de base de datos que YA tiene datos cargados. Ejemplos - "este campo debe tener tamano X", "valida que sea alfanumerico/numerico", "el codigo/DNI/IMEI debe tener este formato", "agrega un catalogo desplegable para X". Tambien cubre el patron de sugerir un valor (ej. un correlativo/codigo autogenerado) sin usar un contador separado que se pueda desincronizar.'
---

# Endurecer la validacion de un campo con datos ya cargados

## Regla 1: verificar los datos reales ANTES de decidir el limite

Nunca reducir el tamano de una columna o agregar un patron estricto sin
antes consultar la base de datos real:

```sql
SELECT MAX(LENGTH(columna)) FROM tabla;
SELECT id, columna FROM tabla WHERE LENGTH(columna) > <nuevo_limite>;
```

En este proyecto esto se hizo antes de cada uno de estos cambios
(`mobile_devices`): `model` a VARCHAR(20), `asset_code` a VARCHAR(8) y
luego VARCHAR(12), `notes` de TEXT a VARCHAR(250) — los tres casos
resultaron seguros porque los 18 registros reales tenian esos campos
vacios, pero **la unica forma de saberlo con certeza es consultando**,
no asumiendo. Si algun registro real violara el nuevo limite, la
migracion (`ALTER ... MODIFY COLUMN`) fallaria o truncaria datos en
silencio segun el modo SQL del motor — ninguna de las dos es aceptable
sin que el usuario lo sepa de antemano.

## Regla 2: cuando el usuario da un formato/tamano que no coincide con un estandar real, decirlo explicitamente

El usuario sugirio IMEI como "8 alfanumerico". El estandar real (GSMA
TS 23.003) es 15 digitos numericos — el "8" que el usuario tenia en
mente corresponde solo al TAC, los primeros 8 digitos del IMEI
completo (y son numericos, no alfanumericos). Se aplico el estandar
real, pero explicando la discrepancia y de donde salia el numero "8"
que el usuario menciono, en vez de aplicarlo en silencio o de
descartar el estandar real por seguir la instruccion literal.

Distinto es cuando el usuario corrige con un dato real del negocio
propio (no un estandar externo): el codigo de activo real es
"A-00868" (con guion), dato que la validacion alfanumerica estricta
pedida un turno antes no contemplaba. Ahi se sigue el dato real del
negocio sin cuestionarlo — la diferencia es que el usuario es la
fuente primaria de su propio formato de codigo interno, mientras que
para el IMEI existe un estandar tecnico externo verificable.

## Regla 3: el formato debe seguir permitiendo casos reales, no solo la definicion literal de la palabra

"Alfanumerico" tomado al pie de la letra excluye espacios y guiones,
pero nombres de modelo reales ("Galaxy A10", "Redmi 9") y codigos
reales ("A-00868") los necesitan. Al implementar, ampliar el patron
para cubrir el caso real (letras+numeros+espacio/guion segun
corresponda) y explicarlo, en vez de aplicar la definicion mas
estricta posible y romper datos legitimos.

## Regla 4: catalogo de un solo valor vs. tabla propia

- Si el campo es un valor de texto simple que el negocio define
  (sede, area, marca, modelo, operadora): usar la tabla generica
  `catalog_items` (`catalog_type` + `value`), administrable desde
  Configuracion > Catalogos sin tocar codigo. Sin FK dura desde la
  tabla que lo usa — el catalogo sugiere/estandariza, nunca bloquea a
  nivel de base de datos (para no romper datos ya importados).
- Si el "valor" en realidad son varios campos relacionados (ej. pais +
  codigo de llamada + cantidad de digitos esperada del numero): usar
  una tabla propia pequena (`phone_country_codes`), NO forzar los
  datos extra dentro de un solo `value` de texto delimitado a mano
  (fragil, dificil de parsear y de validar). Mismo criterio de "sin FK
  dura" que los catalogos genericos.

## Regla 5: un valor sugerido/autogenerado se calcula de los datos reales, nunca con un contador aparte

Para sugerir el siguiente codigo de activo (ej. correlativo tipo
"A-00869" despues de "A-00868") NO se guarda un contador en la tabla
de configuracion — un contador separado se desincroniza en cuanto se
borra un registro o se carga uno con codigo manual fuera de secuencia.
En vez de eso, se calcula en el momento: buscar el numero mas alto ya
usado con el prefijo configurado (`SELECT ... WHERE columna LIKE
'prefijo%'`, extraer la parte numerica, tomar el maximo) y sumar 1.
Mas lento que leer un contador, pero siempre consistente con la
realidad de la tabla. El prefijo y la cantidad de digitos del
correlativo son configurables (tabla `settings`), el valor sugerido
sigue siendo editable a mano en el formulario, nunca forzado.

## Checklist al endurecer un campo

1. `SELECT MAX(LENGTH(...))` y buscar violaciones del nuevo limite
   antes de escribir la migracion.
2. Decidir si el "tamano" pedido es una columna de base de datos, una
   validacion de aplicacion, o ambas (ver README de
   `sql/migrations/`: cambios de esquema van en `schema.sql` +
   migracion incremental).
3. Verificar el patron contra casos reales (nombres con espacios,
   codigos con guion) antes de aplicar la version mas estricta de
   "alfanumerico"/"numerico".
4. Si el usuario da un tamano/formato que contradice un estandar
   tecnico externo verificable, decirlo explicitamente y aplicar el
   estandar real - explicando de donde sale el numero que el usuario
   tenia en mente.
5. Validar en ambas capas: atributos HTML (`maxlength`, `pattern`) para
   feedback inmediato, y el mismo chequeo en el servidor (la validacion
   de HTML nunca es suficiente por si sola).
