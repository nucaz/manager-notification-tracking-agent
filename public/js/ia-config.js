// Formulario de proveedor en Configuracion > Inteligencia artificial:
// muestra los campos que aplican a cada tipo y carga los modelos que
// ofrece el proveedor (POST /configuracion/ia/modelos).
(function () {
  var form = document.getElementById('form_proveedor');
  if (!form) return;
  var kind = document.getElementById('ia_kind');
  var base = document.getElementById('ia_base_url');
  var location = document.getElementById('ia_location');
  var list = document.getElementById('ia_modelos');
  var info = document.getElementById('ia_modelos_info');
  var button = document.getElementById('ia_cargar');
  var first = true;

  function sync() {
    var opt = kind.options[kind.selectedIndex];
    var k = kind.value;
    base.placeholder = opt.getAttribute('data-base');
    document.getElementById('ia_ctx_box').hidden = k !== 'ollama';
    document.getElementById('ia_web_box').hidden = k !== 'gemini';
    // Al cambiar de tipo (no al abrir para editar) se sugiere donde corre.
    if (!first) location.value = opt.getAttribute('data-location');
    first = false;
  }
  kind.addEventListener('change', sync);
  sync();

  button.addEventListener('click', function () {
    var data = new URLSearchParams(new FormData(form));
    button.disabled = true;
    info.textContent = 'Consultando al proveedor...';
    fetch('/configuracion/ia/modelos', { method: 'POST', body: data, credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'No se pudieron cargar los modelos.');
        list.textContent = '';
        res.models.forEach(function (m) {
          var o = document.createElement('option');
          o.value = m.id;
          if (m.detail) o.label = m.id + ' — ' + m.detail;
          list.appendChild(o);
        });
        info.textContent = res.models.length
          ? res.models.length + ' modelo(s): ' + res.models.slice(0, 12).map(function (m) { return m.id + (m.detail ? ' (' + m.detail + ')' : ''); }).join(', ') + (res.models.length > 12 ? '...' : '') + '. Elíjalo en el campo Modelo.'
          : 'El proveedor no tiene modelos. En Ollama: "ollama pull <modelo>" en el servidor.';
      })
      .catch(function (err) { info.textContent = err.message; })
      .then(function () { button.disabled = false; });
  });
})();
