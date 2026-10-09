// Directorio activo: directivas de grupo (GPO). Solo lee lo que adService
// guardo en la ultima lectura del dominio (ad_gpos, ad_gpo_links, ad_ous).
// No se conecta al dominio y no cambia nada.
//
// Lo que se sabe por LDAP: que GPO existen, si estan habilitadas, que TIPO de
// configuracion trae cada una (por sus extensiones), los paquetes de
// instalacion de software, el filtro WMI, donde estan vinculadas y con que
// precedencia. El detalle de cada ajuste (que script, que valor de registro)
// esta en SYSVOL y no se lee aqui.
const pool = require('../db/pool');

// Extensiones del lado cliente (CSE) -> que tipo de configuracion es.
// kind: script | software | restriccion | seguridad | preferencia | otro.
// Identificadores publicados por Microsoft; uno que no este aqui se muestra con su GUID.
const CSE = {
  '35378eac-683f-11d2-a89a-00c04fbbcfa2': ['Plantillas administrativas (registro)', 'restriccion'],
  '827d319e-6eac-11d2-a4ea-00c04f79f83a': ['Seguridad (contraseñas, bloqueo, derechos, grupos restringidos)', 'seguridad'],
  '42b5faae-6536-11d2-ae5a-0000f87571e3': ['Scripts (inicio, apagado, inicio y cierre de sesión)', 'script'],
  'c6dc5466-785a-11d2-84d0-00c04fb169f7': ['Instalación de software (MSI)', 'software'],
  '25537ba6-77a8-11d2-9b6c-0000f8080861': ['Redirección de carpetas', 'preferencia'],
  'a2e30f80-d7de-11d2-bbde-00c04f86ae3b': ['Mantenimiento de Internet Explorer', 'restriccion'],
  'b1be8d72-6eac-11d2-a4ea-00c04f79f83a': ['Recuperación de EFS', 'seguridad'],
  'e437bc1c-aa7d-11d2-a382-00c04f991e27': ['Seguridad IP (IPsec)', 'seguridad'],
  '0acdd40c-75ac-47ab-baa0-bf6de7e7fe63': ['Redes inalámbricas', 'seguridad'],
  'b587e2b1-4d59-4e7e-aed9-22b9df11d053': ['Redes cableadas (802.1X)', 'seguridad'],
  'f3ccc681-b74c-4060-9f26-cd84525dca2a': ['Auditoría avanzada', 'seguridad'],
  '62c1845d-c4a6-4acb-bbb0-c895fd090385': ['AppLocker (restricción de aplicaciones)', 'restriccion'],
  'd76b9641-3288-4f75-942d-087de603e3ea': ['LAPS (contraseña del administrador local)', 'seguridad'],
  '5794dafd-be60-433f-88a2-1a31939ac01f': ['Unidades de red', 'preferencia'],
  '0e28e245-9368-4853-ad84-6da3ba35bb75': ['Variables de entorno', 'preferencia'],
  '7150f9bf-48ad-4da4-a49c-29ef4a8369ba': ['Archivos', 'preferencia'],
  '6232c319-91ac-4931-9385-e70c2b099f0e': ['Carpetas', 'preferencia'],
  '74ee6c03-5363-4554-b161-627540339cab': ['Archivos .ini', 'preferencia'],
  'b087be9d-ed37-454f-af9c-04291e351182': ['Registro (preferencias)', 'preferencia'],
  'c418dd9d-0d14-4efb-8fbf-cfe535c8fac7': ['Accesos directos', 'preferencia'],
  '17d89fec-5c44-4972-b12d-241caef74509': ['Usuarios y grupos locales', 'seguridad'],
  'bc75b1ed-5833-4858-9bb8-cbf0b166df9d': ['Impresoras', 'preferencia'],
  'aadced64-746c-4633-a97c-d61349046527': ['Tareas programadas', 'script'],
  '91fbb303-0cd5-4055-bf42-e512a681b325': ['Servicios', 'preferencia'],
  'e47248ba-94cc-49c4-bbb5-9eb7f05183d0': ['Configuración de Internet', 'preferencia'],
  'e5094040-c46c-4115-b030-04fb2e545b00': ['Opciones de energía', 'preferencia'],
  'e62688f0-25fd-4c90-bff5-f508b9d2e31f': ['Opciones de carpeta', 'preferencia'],
  '3a0dba37-f8b2-4356-83de-3e90bd5c261f': ['Opciones de red', 'preferencia'],
  '1a6364eb-776b-4120-ade1-b63a406a76b5': ['Dispositivos', 'restriccion'],
  '728ee579-943c-4519-9ef7-ab56765798ed': ['Orígenes de datos', 'preferencia'],
  'e4f48e54-f38d-4884-bfb9-d4d2e5729c18': ['Menú Inicio', 'preferencia'],
  'f9c77450-3a41-477e-9310-9acd617bd9e3': ['Aplicaciones', 'preferencia'],
};
const KINDS = {
  script: ['Scripts y tareas', 'bi-terminal', 'primary'], software: ['Despliegue de software', 'bi-box-seam', 'info'],
  restriccion: ['Restricciones', 'bi-slash-circle', 'warning'], seguridad: ['Seguridad', 'bi-shield-lock', 'danger'],
  preferencia: ['Preferencias', 'bi-sliders', 'secondary'], otro: ['Otras', 'bi-puzzle', 'secondary'],
};
const extOf = (csv) => String(csv || '').split(',').filter(Boolean).map((g) => ({ guid: g, label: (CSE[g] || [`Extensión {${g.toUpperCase()}}`])[0], kind: (CSE[g] || [null, 'otro'])[1] }));
const lc = (s) => String(s || '').toLowerCase();

function decorate(g, links) {
  const mine = links.filter((l) => l.gpo_id === g.id);
  const computer = extOf(g.computer_ext);
  const user = extOf(g.user_ext);
  let software = [];
  try { software = JSON.parse(g.software_json || '[]'); } catch (_) { software = []; }
  const active = mine.filter((l) => l.link_enabled);
  const kinds = [...new Set([...computer, ...user].map((e) => e.kind))];
  const status = !g.computer_enabled && !g.user_enabled ? 'Deshabilitada'
    : (!g.computer_enabled ? 'Solo usuario' : (!g.user_enabled ? 'Solo equipo' : 'Habilitada'));
  // Avisos de higiene: lo que conviene revisar.
  const notes = [];
  if (!mine.length) notes.push('Sin vincular: no se aplica en ningún sitio.');
  else if (!active.length) notes.push('Todos sus vínculos están deshabilitados.');
  if (!g.computer_version && !g.user_version) notes.push('Vacía: nunca se le configuró nada.');
  if (status === 'Deshabilitada') notes.push('Deshabilitada por completo.');
  if (g.computer_enabled && !g.computer_version && g.user_version) notes.push('La parte de equipo está habilitada pero vacía: deshabilitarla acelera el arranque.');
  if (g.user_enabled && !g.user_version && g.computer_version) notes.push('La parte de usuario está habilitada pero vacía: deshabilitarla acelera el inicio de sesión.');
  return { ...g, links: mine, activeLinks: active, computer, user, software, kinds, status, notes };
}

async function raw() {
  const [gpos] = await pool.query('SELECT * FROM ad_gpos ORDER BY name');
  const [links] = await pool.query('SELECT * FROM ad_gpo_links ORDER BY target_kind, target_dn, link_order');
  return { gpos, links };
}

async function list() {
  const { gpos, links } = await raw();
  return gpos.map((g) => decorate(g, links));
}

async function get(guid) {
  const all = await list();
  return all.find((g) => g.gpo_guid === lc(guid)) || null;
}

// Vinculos que apuntan a una GPO que ya no existe.
async function orphanLinks() {
  const [rows] = await pool.query('SELECT * FROM ad_gpo_links WHERE gpo_id IS NULL ORDER BY target_dn');
  return rows;
}

// Que GPO se aplican en cada contenedor, en orden de precedencia (la primera
// gana). Reglas de Windows: se procesa dominio -> OU de arriba -> OU de abajo
// y gana lo ultimo; un vinculo "exigido" gana siempre (y entre exigidos, el de
// mas arriba); una OU con herencia bloqueada no recibe los no exigidos de
// arriba. Los vinculos de sitio dependen de la red del equipo y no entran.
function effectiveFor(chain, linksByDn, gpoById) {
  // chain: [{ dn, name, block }] desde el dominio hasta el contenedor.
  const usable = (l) => l.link_enabled && l.gpo_id && gpoById.has(l.gpo_id) && (gpoById.get(l.gpo_id).computer_enabled || gpoById.get(l.gpo_id).user_enabled);
  const enforced = [];
  let normal = [];
  chain.forEach((c, depth) => {
    const here = (linksByDn.get(lc(c.dn)) || []).filter(usable).sort((a, b) => a.link_order - b.link_order);
    if (c.block && depth > 0) normal = [];
    const own = depth === chain.length - 1;
    here.filter((l) => l.enforced).forEach((l) => enforced.push({ link: l, from: c, own }));
    // Lo de mas abajo gana: va delante.
    normal = [...here.filter((l) => !l.enforced).map((l) => ({ link: l, from: c, own })), ...normal];
  });
  const seen = new Set();
  return [...enforced, ...normal].filter((x) => { if (seen.has(x.link.gpo_id)) return false; seen.add(x.link.gpo_id); return true; })
    .map((x, i) => ({ order: i + 1, gpo: gpoById.get(x.link.gpo_id), enforced: !!x.link.enforced, inherited: !x.own, from: x.from.name, fromDn: x.from.dn }));
}

// Arbol de aplicacion: dominio y cada OU con lo que tiene vinculado y lo que le llega.
async function application() {
  const { gpos, links } = await raw();
  const [ous] = await pool.query("SELECT * FROM ad_ous WHERE removed_at IS NULL ORDER BY dn");
  const gpoById = new Map(gpos.map((g) => [g.id, decorate(g, links)]));
  const linksByDn = new Map();
  links.forEach((l) => { const k = lc(l.target_dn); linksByDn.set(k, [...(linksByDn.get(k) || []), l]); });
  const domainLink = links.find((l) => l.target_kind === 'dominio');
  const ouByDn = new Map(ous.map((o) => [lc(o.dn), o]));
  // El dominio: el padre de la OU de mas arriba.
  const top = ous.find((o) => !ouByDn.has(lc(o.parent_dn)));
  const domainDn = domainLink ? domainLink.target_dn : (top ? top.parent_dn : '');
  const domainName = domainLink ? domainLink.target_name : domainDn.split(',').map((p) => p.replace(/^DC=/i, '')).join('.');
  const domain = { dn: domainDn, name: domainName, block: false };
  const chainOf = (o) => {
    const c = [];
    for (let x = o; x; x = ouByDn.get(lc(x.parent_dn))) c.unshift({ dn: x.dn, name: x.name, block: !!x.gp_block });
    return [domain, ...c];
  };
  const mapLinks = (dn) => (linksByDn.get(lc(dn)) || []).slice().sort((a, b) => a.link_order - b.link_order)
    .map((l) => ({ ...l, gpo: l.gpo_id ? gpoById.get(l.gpo_id) : null }));
  const nodes = ous.map((o) => {
    const chain = chainOf(o);
    return { ...o, depth: chain.length - 1, path: chain.slice(1).map((c) => c.name).join(' / '), links: mapLinks(o.dn), effective: effectiveFor(chain, linksByDn, gpoById) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'es'));
  return {
    domain: { ...domain, links: mapLinks(domainDn), effective: effectiveFor([domain], linksByDn, gpoById) },
    nodes,
    sites: links.filter((l) => l.target_kind === 'sitio').map((l) => ({ ...l, gpo: l.gpo_id ? gpoById.get(l.gpo_id) : null })),
  };
}

// Cifras para el resumen.
async function overview() {
  const all = await list();
  return {
    total: all.length,
    unlinked: all.filter((g) => !g.links.length).length,
    empty: all.filter((g) => !g.computer_version && !g.user_version).length,
    disabled: all.filter((g) => g.status === 'Deshabilitada').length,
    scripts: all.filter((g) => g.kinds.includes('script')).length,
    software: all.filter((g) => g.kinds.includes('software') || g.software.length).length,
    restrictions: all.filter((g) => g.kinds.includes('restriccion')).length,
    orphanLinks: (await orphanLinks()).length,
  };
}

module.exports = { CSE, KINDS, list, get, orphanLinks, application, overview, _: { effectiveFor, extOf, decorate } };
