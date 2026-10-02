// Tablas de listado de toda la aplicacion: cuantos registros mostrar,
// columnas que se pueden estirar y cambiar de lugar. Se aplica solo, a toda
// tabla con encabezado que este dentro de un .table-responsive; lo que cada
// persona ajusta se recuerda en su navegador, por pantalla y por tabla.
//
// Para dejar una tabla como esta: <table data-tabla="no">.
// Una tabla que ya pagina en el servidor (trae su propio .pagination en la
// misma tarjeta) conserva su paginacion; solo gana las columnas ajustables.
(function () {
  'use strict';

  var SIZES = [10, 20, 30, 40, 50, 100, 0]; // 0 = todos
  var DEFAULT_SIZE = 50;
  var MIN_WIDTH = 48;
  var PAGER_FROM = 10; // con 10 filas o menos no hace falta paginar

  function load(key) {
    try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { return {}; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* navegador sin almacenamiento: no se recuerda */ }
  }

  function setup(table, index) {
    var head = table.tHead;
    if (!head || !head.rows.length || table.getAttribute('data-tabla') === 'no') return;
    var headRow = head.rows[head.rows.length - 1];
    var total = headRow.cells.length;
    if (total < 2) return;
    var key = 'tabla:' + location.pathname + ':' + index;
    var prefs = load(key);
    var wrap = table.parentNode;

    // Nombre estable de cada columna (para recordar orden y ancho aunque
    // cambie su posicion): data-col, o el texto del encabezado.
    var seen = {};
    Array.prototype.forEach.call(headRow.cells, function (th, i) {
      var name = th.getAttribute('data-col') || th.textContent.replace(/\s+/g, ' ').trim() || 'col' + i;
      seen[name] = (seen[name] || 0) + 1;
      th.setAttribute('data-columna', seen[name] > 1 ? name + '#' + seen[name] : name);
    });
    var names = function () {
      return Array.prototype.map.call(headRow.cells, function (th) { return th.getAttribute('data-columna'); });
    };

    // Las filas con celdas combinadas (totales, "no hay registros") no se
    // pueden reordenar por columna: si las hay fuera del cuerpo, las
    // columnas no se mueven en esa tabla (si se estiran).
    var movable = Array.prototype.every.call(table.rows, function (row) {
      return row.cells.length === total || (row.parentNode.tagName === 'TBODY' && row.cells.length === 1);
    });

    function moveColumn(from, to) {
      if (from === to) return;
      Array.prototype.forEach.call(table.rows, function (row) {
        if (row.cells.length !== total) return;
        var cell = row.cells[from];
        row.insertBefore(cell, to < from ? row.cells[to] : row.cells[to].nextSibling);
      });
    }

    if (movable && Array.isArray(prefs.orden)) {
      prefs.orden.forEach(function (name, target) {
        var current = names().indexOf(name);
        if (current > -1 && target < total) moveColumn(current, target);
      });
    }

    var body = table.tBodies[0];

    // --- Ancho de columnas -------------------------------------------
    // Al primer ajuste la tabla pasa a anchos fijos (los que tenia en ese
    // momento), para que estirar una columna no encoja las demas: la tabla
    // crece y su contenedor se desplaza.
    function freeze() {
      if (table.classList.contains('tabla-fija')) return;
      // Se mide con TODAS las filas a la vista: el ancho natural de una
      // columna depende de las filas visibles, y el de otra pagina puede
      // ser unos pixeles mayor (quedaria cortado con puntos suspensivos).
      var hidden = body ? Array.prototype.filter.call(body.rows, function (r) { return r.hidden; }) : [];
      hidden.forEach(function (r) { r.hidden = false; });
      // offsetWidth redondea hacia abajo: con el ancho exacto, medio pixel
      // de menos ya recorta el texto. Se redondea hacia arriba, con holgura.
      var widths = Array.prototype.map.call(headRow.cells, function (th) {
        return th.offsetWidth ? Math.ceil(th.getBoundingClientRect().width) + 1 : 0;
      });
      hidden.forEach(function (r) { r.hidden = true; });
      Array.prototype.forEach.call(headRow.cells, function (th, i) { if (widths[i]) th.style.width = widths[i] + 'px'; });
      table.style.width = widths.reduce(function (a, b) { return a + b; }, 0) + 'px';
      table.classList.add('tabla-fija');
    }

    function applyWidths() {
      if (!prefs.anchos || !Object.keys(prefs.anchos).length) return;
      freeze();
      var sum = 0;
      Array.prototype.forEach.call(headRow.cells, function (th) {
        var w = prefs.anchos[th.getAttribute('data-columna')];
        if (w && th.offsetWidth) th.style.width = w + 'px';
        sum += w && th.offsetWidth ? w : th.offsetWidth;
      });
      table.style.width = sum + 'px';
    }

    Array.prototype.forEach.call(headRow.cells, function (th) {
      var grip = document.createElement('span');
      grip.className = 'col-ancho';
      grip.title = 'Arrastre para cambiar el ancho de la columna';
      th.appendChild(grip);
      grip.addEventListener('mousedown', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        freeze();
        var startX = ev.clientX;
        var startW = th.offsetWidth;
        var startTable = table.offsetWidth;
        th.draggable = false;
        document.body.classList.add('ajustando-columna');
        function move(e) {
          var w = Math.max(MIN_WIDTH, startW + e.clientX - startX);
          th.style.width = w + 'px';
          table.style.width = startTable + w - startW + 'px';
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.classList.remove('ajustando-columna');
          th.draggable = movable;
          prefs.anchos = prefs.anchos || {};
          Array.prototype.forEach.call(headRow.cells, function (cell) {
            if (cell.offsetWidth) prefs.anchos[cell.getAttribute('data-columna')] = cell.offsetWidth;
          });
          save(key, prefs);
          showReset();
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
      grip.addEventListener('click', function (ev) { ev.stopPropagation(); });

      // --- Mover columnas (arrastrar el encabezado) -------------------
      if (!movable) return;
      th.draggable = true;
      th.classList.add('col-movible');
      th.addEventListener('dragstart', function (ev) {
        table._desde = Array.prototype.indexOf.call(headRow.cells, th);
        th.classList.add('col-arrastrando');
        try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', th.getAttribute('data-columna')); } catch (e) { /* IE */ }
      });
      th.addEventListener('dragend', function () {
        table._desde = undefined;
        Array.prototype.forEach.call(headRow.cells, function (c) { c.classList.remove('col-arrastrando', 'col-destino'); });
      });
      th.addEventListener('dragover', function (ev) {
        if (table._desde === undefined) return;
        ev.preventDefault();
        th.classList.add('col-destino');
      });
      th.addEventListener('dragleave', function () { th.classList.remove('col-destino'); });
      th.addEventListener('drop', function (ev) {
        if (table._desde === undefined) return;
        ev.preventDefault();
        moveColumn(table._desde, Array.prototype.indexOf.call(headRow.cells, th));
        prefs.orden = names();
        save(key, prefs);
        showReset();
      });
    });

    // --- Pie: registros por pagina y restablecer ----------------------
    var foot = document.createElement('div');
    foot.className = 'tabla-pie';
    wrap.parentNode.insertBefore(foot, wrap.nextSibling);

    var reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'btn btn-link btn-sm p-0 tabla-restablecer';
    reset.textContent = 'Restablecer columnas';
    reset.title = 'Vuelve al orden y los anchos originales de esta tabla';
    reset.addEventListener('click', function () {
      delete prefs.orden;
      delete prefs.anchos;
      save(key, prefs);
      location.reload();
    });
    function showReset() { reset.hidden = !(prefs.orden || prefs.anchos); }

    var rows = body ? Array.prototype.filter.call(body.rows, function (r) { return r.cells.length === total; }) : [];
    var card = table.closest ? table.closest('.card') : null;
    var serverPaged = table.getAttribute('data-tabla') === 'servidor' || !!(card && card.querySelector('.pagination'));

    if (!serverPaged && rows.length > PAGER_FROM) {
      var size = SIZES.indexOf(Number(prefs.filas)) > -1 ? Number(prefs.filas) : DEFAULT_SIZE;
      var page = 0;

      var label = document.createElement('label');
      label.className = 'tabla-filas';
      label.appendChild(document.createTextNode('Mostrar '));
      var select = document.createElement('select');
      select.className = 'form-select form-select-sm';
      select.setAttribute('aria-label', 'Registros por página');
      SIZES.forEach(function (n) {
        var o = document.createElement('option');
        o.value = String(n);
        o.textContent = n ? String(n) : 'Todos';
        select.appendChild(o);
      });
      select.value = String(size);
      label.appendChild(select);
      label.appendChild(document.createTextNode(' registros'));

      var info = document.createElement('span');
      info.className = 'tabla-info text-muted';
      var prev = document.createElement('button');
      var next = document.createElement('button');
      [prev, next].forEach(function (b, i) {
        b.type = 'button';
        b.className = 'btn btn-sm btn-outline-secondary';
        b.textContent = i ? 'Siguiente' : 'Anterior';
      });

      var render = function () {
        var per = size || rows.length;
        var pages = Math.max(Math.ceil(rows.length / per), 1);
        page = Math.min(Math.max(page, 0), pages - 1);
        var from = page * per;
        var changed = null;
        rows.forEach(function (row, i) {
          var hide = i < from || i >= from + per;
          row.hidden = hide;
          if (!hide) return;
          // Lo marcado en una pagina que deja de verse se desmarca: una
          // accion masiva no debe alcanzar filas que no estan a la vista.
          Array.prototype.forEach.call(row.querySelectorAll('input[type="checkbox"]:checked'), function (cb) { cb.checked = false; changed = cb; });
        });
        if (changed) changed.dispatchEvent(new Event('change', { bubbles: true }));
        info.textContent = (from + 1) + '–' + Math.min(from + per, rows.length) + ' de ' + rows.length;
        prev.disabled = page === 0;
        next.disabled = page >= pages - 1;
        prev.hidden = next.hidden = pages === 1;
      };
      select.addEventListener('change', function () {
        size = Number(select.value);
        page = 0;
        prefs.filas = size;
        save(key, prefs);
        render();
      });
      prev.addEventListener('click', function () { page -= 1; render(); });
      next.addEventListener('click', function () { page += 1; render(); });
      foot.appendChild(label);
      foot.appendChild(info);
      foot.appendChild(prev);
      foot.appendChild(next);
      render();
    }
    foot.appendChild(reset);
    showReset();
    applyWidths();
  }

  function init() {
    // Una tabla de listado que no venia dentro de un contenedor con
    // desplazamiento lo recibe aqui: al estirar columnas puede crecer mas
    // que la pagina.
    Array.prototype.forEach.call(document.querySelectorAll('table.table'), function (table) {
      if (!table.tHead || table.getAttribute('data-tabla') === 'no' || table.parentNode.classList.contains('table-responsive')) return;
      var wrap = document.createElement('div');
      wrap.className = 'table-responsive';
      table.parentNode.insertBefore(wrap, table);
      wrap.appendChild(table);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.table-responsive > table'), setup);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
