// Panel "Preguntar a la IA" (aparece en todas las pantallas, ver
// views/partials/foot.ejs). Envia la pregunta a /asistente/preguntar y
// muestra la respuesta, las tablas que calculo la aplicacion y las fuentes
// de internet. La conversacion se conserva mientras dure la pestaña.
(function () {
  'use strict';

  var panel = document.getElementById('ia_panel');
  if (!panel) return;
  var csrf = panel.getAttribute('data-csrf');
  var hilo = document.getElementById('ia_hilo');
  var form = document.getElementById('ia_form');
  var input = document.getElementById('ia_pregunta');
  var send = document.getElementById('ia_enviar');
  var modelBox = document.getElementById('ia_modelo_box');
  var modelSelect = document.getElementById('ia_modelo');
  var privacy = document.getElementById('ia_privacidad');
  var KEY = 'asistente:hilo';
  var MODEL_KEY = 'asistente:modelo';
  var choices = null; // { allowed, defaultId, providers: [{ id, label, location, model }] }
  var MAX_TURNS = 15;
  var busy = false;

  // Sugerencias segun la pantalla desde donde se pregunta.
  var EXAMPLES = [
    [/^\/celulares\/chips/, ['¿Cuántos chips hay por operadora y cuánto se paga?', 'Chips en stock, sin celular', 'Chips de baja']],
    [/^\/celulares/, ['Stock de celulares por sede', 'Celulares por área y estado', 'Busca en internet las características del modelo que más tenemos']],
    [/^\/glpi/, ['¿Cuántas computadoras hay por entidad?', 'Computadoras por sistema operativo', 'Monitores por fabricante']],
    [/^\/licencias/, ['Licencias que vencen en los próximos 60 días', 'Costo total de licencias por proveedor']],
    [/./, ['Stock de celulares por sede', '¿Qué vence en los próximos 30 días?', '¿Cuántas computadoras, monitores e impresoras hay?']],
  ];

  function load() {
    try { return JSON.parse(sessionStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; }
  }
  function save(turns) {
    try { sessionStorage.setItem(KEY, JSON.stringify(turns.slice(-MAX_TURNS))); } catch (e) { /* sin almacenamiento: no se recuerda */ }
  }
  var turns = load();

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  // Texto de la IA: se escribe como texto (nunca como HTML). Solo se
  // interpretan **negritas**, listas con "-" o "*" y saltos de linea.
  function rich(text) {
    var box = el('div', 'ia-texto');
    var list = null;
    String(text || '').split('\n').forEach(function (line) {
      var item = /^\s*[-*•]\s+(.*)$/.exec(line);
      var target;
      if (item) {
        if (!list) { list = el('ul'); box.appendChild(list); }
        target = el('li');
        list.appendChild(target);
        line = item[1];
      } else {
        list = null;
        if (!line.trim()) return;
        target = el('p');
        box.appendChild(target);
        line = line.replace(/^#+\s*/, '');
      }
      line.split(/(\*\*[^*]+\*\*)/).forEach(function (chunk) {
        if (/^\*\*[^*]+\*\*$/.test(chunk)) target.appendChild(el('strong', null, chunk.slice(2, -2)));
        else if (chunk) target.appendChild(document.createTextNode(chunk));
      });
    });
    return box;
  }

  function tableNode(t) {
    var wrap = el('div', 'ia-tabla');
    wrap.appendChild(el('div', 'ia-tabla-titulo', t.title));
    var scroll = el('div', 'ia-tabla-scroll');
    var table = el('table', 'table table-sm table-striped mb-0');
    table.setAttribute('data-tabla', 'no');
    var head = el('tr');
    t.columns.forEach(function (c) { head.appendChild(el('th', null, c)); });
    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);
    var body = el('tbody');
    t.rows.forEach(function (r) {
      var tr = el('tr');
      r.forEach(function (v) { tr.appendChild(el('td', typeof v === 'number' ? 'text-end' : null, v === '' || v === null ? '—' : String(v))); });
      body.appendChild(tr);
    });
    if (!t.rows.length) {
      var empty = el('td', 'text-center text-muted', 'Sin registros.');
      empty.colSpan = t.columns.length;
      var tr0 = el('tr');
      tr0.appendChild(empty);
      body.appendChild(tr0);
    }
    table.appendChild(body);
    scroll.appendChild(table);
    wrap.appendChild(scroll);

    var foot = el('div', 'ia-tabla-pie');
    var count = t.total + ' registro(s)';
    if (t.shown < t.lines) count += ' · se muestran ' + t.shown + ' de ' + t.lines + ' filas (el reporte y el Excel las traen todas)';
    foot.appendChild(el('span', 'text-muted', count));
    // Envia la consulta (no las filas) por formulario: el servidor la vuelve a ejecutar.
    function post(action, extra, newTab) {
      var f = el('form');
      f.method = 'post';
      f.action = action;
      f.hidden = true;
      if (newTab) f.target = '_blank';
      [['_csrf', csrf], ['spec', JSON.stringify(t.spec)]].concat(extra || []).forEach(function (pair) {
        var i = el('input');
        i.type = 'hidden';
        i.name = pair[0];
        i.value = pair[1];
        f.appendChild(i);
      });
      document.body.appendChild(f);
      f.submit();
      f.remove();
    }
    var open = el('button', 'btn btn-sm btn-outline-primary', 'Abrir como reporte');
    open.type = 'button';
    open.title = 'Reporte temporal a pantalla completa, con todas las filas, Excel y PDF. No se guarda.';
    open.addEventListener('click', function () { post('/asistente/reporte', null, true); });
    foot.appendChild(open);
    var excel = el('button', 'btn btn-sm btn-outline-success', 'Descargar Excel');
    excel.type = 'button';
    excel.addEventListener('click', function () { post('/asistente/exportar'); });
    foot.appendChild(excel);
    if (t.reportUrl && /^\/reportes\?/.test(t.reportUrl)) {
      var link = el('a', 'btn btn-sm btn-outline-secondary', 'Abrir en Reportes');
      link.href = t.reportUrl;
      link.title = 'El mismo resultado en Reportes, con PDF para imprimir (código de barras)';
      foot.appendChild(link);
    }
    wrap.appendChild(foot);
    return wrap;
  }

  function turnNode(turn) {
    var node = el('div', 'ia-turno');
    node.appendChild(el('div', 'ia-pregunta', turn.q));
    var reply = el('div', 'ia-respuesta' + (turn.error ? ' ia-error' : ''));
    if (turn.pending) {
      reply.appendChild(el('span', 'spinner-border spinner-border-sm me-2'));
      reply.appendChild(document.createTextNode(turn.local ? 'Consultando al servidor local… (puede tardar un poco)' : 'Consultando…'));
    } else {
      reply.appendChild(rich(turn.error || turn.a));
      if (turn.notice) reply.appendChild(el('div', 'small text-warning mt-1', turn.notice));
      (turn.tables || []).forEach(function (t) { reply.appendChild(tableNode(t)); });
      if (turn.sources && turn.sources.length) {
        var src = el('div', 'ia-fuentes');
        src.appendChild(el('span', 'text-muted', 'Fuentes en internet: '));
        turn.sources.forEach(function (s, i) {
          if (!/^https?:\/\//i.test(s.url)) return;
          if (i) src.appendChild(document.createTextNode(' · '));
          var a = el('a', null, s.title || s.url);
          a.href = s.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          src.appendChild(a);
        });
        reply.appendChild(src);
      }
    }
    if (turn.provider) {
      node.appendChild(el('div', 'ia-modelo-usado', 'Respondió ' + turn.provider.label + ' · ' + turn.provider.model + (turn.provider.location === 'local' ? ' (local)' : ' (nube)')));
    }
    node.appendChild(reply);
    return node;
  }

  function render() {
    hilo.textContent = '';
    if (!turns.length) {
      var intro = el('div', 'ia-inicio');
      intro.appendChild(el('p', 'mb-2', 'Converse con libertad: pregunte por lo que hay registrado, pida resúmenes, listados o reportes, o que busque un modelo, una tecnología o cualquier tema en internet. Puede consultar todo lo que usted puede ver; no puede crear ni cambiar datos.'));
      var list = EXAMPLES.filter(function (e) { return e[0].test(location.pathname); })[0][1];
      list.forEach(function (q) {
        var b = el('button', 'btn btn-sm btn-outline-primary ia-ejemplo', q);
        b.type = 'button';
        b.addEventListener('click', function () { ask(q); });
        intro.appendChild(b);
      });
      hilo.appendChild(intro);
    }
    turns.forEach(function (t) { hilo.appendChild(turnNode(t)); });
    hilo.scrollTop = hilo.scrollHeight;
  }

  function ask(question) {
    question = String(question || '').trim();
    if (!question || busy) return;
    busy = true;
    send.disabled = true;
    var history = turns.filter(function (t) { return t.a && !t.error; }).slice(-6).map(function (t) { return { q: t.q, a: t.a }; });
    var chosen = selected();
    var turn = { q: question, pending: true, local: !!(chosen && chosen.location === 'local') };
    turns.push(turn);
    render();
    input.value = '';

    fetch('/asistente/preguntar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ _csrf: csrf, question: question, page: location.pathname, history: history, provider_id: modelBox.hidden || !chosen ? null : chosen.id }),
    }).then(function (res) {
      return res.text().then(function (body) {
        var data;
        try { data = JSON.parse(body); } catch (e) { data = null; }
        if (!data) throw new Error(res.status === 200 ? 'Su sesión expiró. Recargue la página e inicie sesión.' : 'El servidor respondió con un error (' + res.status + ').');
        if (!data.ok) throw new Error(data.error || 'No se pudo responder.');
        return data;
      });
    }).then(function (data) {
      turn.a = data.answer;
      turn.tables = data.tables;
      turn.sources = data.sources;
      turn.provider = data.provider;
      turn.notice = data.notice;
    }).catch(function (err) {
      turn.error = err.message || 'No se pudo consultar.';
    }).then(function () {
      delete turn.pending;
      delete turn.local;
      busy = false;
      send.disabled = false;
      save(turns);
      render();
      input.focus();
    });
  }

  form.addEventListener('submit', function (ev) { ev.preventDefault(); ask(input.value); });
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); ask(input.value); }
  });
  document.getElementById('ia_nueva').addEventListener('click', function () {
    if (busy) return;
    turns = [];
    save(turns);
    render();
    input.focus();
  });
  // Modelo para la pregunta: el asignado al asistente, u otro si la
  // configuracion deja elegir. Se recuerda la ultima eleccion.
  function selected() {
    if (!choices) return null;
    var id = Number(modelSelect.value) || choices.defaultId;
    return choices.providers.filter(function (p) { return p.id === id; })[0] || choices.providers[0] || null;
  }
  function showPrivacy() {
    var p = selected();
    privacy.textContent = !p ? '' : p.location === 'local'
      ? 'Responde ' + p.label + ' (servidor de la empresa): los datos no salen de la red.' + (choices.webLabel ? ' Solo las búsquedas en internet, si las hace, pasan por ' + choices.webLabel + '.' : '')
      : 'La pregunta y los datos necesarios para responderla se envían a ' + p.label + ' (en la nube).';
  }
  function loadModels() {
    if (choices) return;
    fetch('/asistente/modelos', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ _csrf: csrf }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.ok) throw new Error((data && data.error) || 'sin respuesta');
      choices = data;
      modelSelect.textContent = '';
      data.providers.forEach(function (p) {
        var o = el('option', null, p.label + ' · ' + p.model + (p.location === 'local' ? ' (local)' : ' (nube)'));
        o.value = p.id;
        modelSelect.appendChild(o);
      });
      // Los inactivos se ven pero no se eligen: asi se entiende por que
      // no aparece, por ejemplo, el de la nube.
      (data.inactive || []).forEach(function (p) {
        var o = el('option', null, p.label + ' · ' + p.model + ' (inactivo: actívelo en Configuración > IA)');
        o.value = p.id;
        o.disabled = true;
        modelSelect.appendChild(o);
      });
      var remembered = null;
      try { remembered = Number(localStorage.getItem(MODEL_KEY)); } catch (e) { /* sin almacenamiento */ }
      var ids = data.providers.map(function (p) { return p.id; });
      modelSelect.value = String(ids.indexOf(remembered) > -1 ? remembered : (ids.indexOf(data.defaultId) > -1 ? data.defaultId : (ids[0] || '')));
      modelBox.hidden = !(data.allowed && data.providers.length + (data.inactive || []).length > 1);
      if (modelBox.hidden) modelSelect.value = String(ids.indexOf(data.defaultId) > -1 ? data.defaultId : (ids[0] || ''));
      showPrivacy();
    }).catch(function (err) {
      // Responde el modelo asignado; se avisa en vez de dejar el selector vacio.
      modelBox.hidden = true;
      privacy.textContent = 'No se pudo cargar la lista de modelos (' + err.message + '): responde el asignado al asistente.';
    });
  }
  modelSelect.addEventListener('change', function () {
    try { localStorage.setItem(MODEL_KEY, modelSelect.value); } catch (e) { /* sin almacenamiento */ }
    showPrivacy();
  });

  panel.addEventListener('shown.bs.offcanvas', function () { loadModels(); render(); input.focus(); });
  render();
})();
