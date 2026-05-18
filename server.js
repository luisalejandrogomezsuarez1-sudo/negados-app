// NegadosApp — Servidor con control de accesos
const http = require('http');
const fs   = require('fs');
const path = require('path');
// url module not needed — using WHATWG URL API

const PORT     = process.env.PORT || 3000;
const PUBLIC   = path.join(__dirname, 'public');
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Limpiar sesiones al iniciar (evita sesiones fantasma) ────
const sesFile = path.join(DATA_DIR, 'sesiones.json');
fs.writeFileSync(sesFile, '{}', 'utf8');
console.log('  Sesiones limpiadas al iniciar');

// Clean duplicate usuarios on startup
try {
  const uDB = readDB('usuarios');
  const seen = new Map();
  const cleaned = [];
  uDB.forEach(u => {
    const key = String(u.celular).trim();
    if (!seen.has(key)) {
      seen.set(key, true);
      cleaned.push({ ...u, nombre: String(u.nombre||'').toLowerCase() });
    }
  });
  if (cleaned.length < uDB.length) {
    writeDB('usuarios', cleaned);
    console.log('  Duplicados removidos:', uDB.length - cleaned.length);
  }
} catch(e) {}

// ── Auto-repair corrupt JSON files on startup ─────────────────
const DB_FILES = ['usuarios','registros','merch','ventas','tracking','accesos'];
DB_FILES.forEach(name => {
  const f = path.join(DATA_DIR, name + '.json');
  if (!fs.existsSync(f)) return;
  try {
    const content = fs.readFileSync(f, 'utf8').trim();
    if (!content) { fs.writeFileSync(f, '[]', 'utf8'); return; }
    JSON.parse(content);
  } catch(e) {
    const backup = f + '.bak.' + Date.now();
    fs.renameSync(f, backup);
    fs.writeFileSync(f, '[]', 'utf8');
    console.log('  Repaired corrupt file:', name, '(backup saved as .bak)');
  }
});

// ── Admin ─────────────────────────────────────────────────────
// ── Administradores ──────────────────────────────────────────
const ADMINS = [
  { cel: '85489705', nom: 'luis gomez',       rol: 'superadmin' }, // Luis Gomez — acceso total
  { cel: '6143551',  nom: 'yolanda barranco', rol: 'admin' },       // Yolanda — todo menos eliminar/desactivar asesores
];

function getAdmin(cel, nom) {
  return ADMINS.find(a =>
    String(a.cel).trim() === String(cel).trim() &&
    String(nom||'').toLowerCase().trim() === a.nom
  ) || null;
}
// Check if user is admin — either in ADMINS array OR has rol=admin in accesos DB
function isAdmin(cel, nom) {
  if (getAdmin(cel, nom)) return true;
  const accesos = readDB('accesos');
  const acc = accesos.find(a => String(a.celular).trim() === String(cel).trim() && a.activo === true && a.rol === 'admin');
  return !!acc;
}
function isSuperAdmin(cel, nom) { const a=getAdmin(cel,nom); return a && a.rol==='superadmin'; }
function canManageAccesos(cel, nom) { return isSuperAdmin(cel, nom); } // solo superadmin puede eliminar/desactivar


// ── DB helpers ────────────────────────────────────────────────
function readDB(name) {
  try {
    const f = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(f)) return [];
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) { return []; }
}
function writeDB(name, arr) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(arr), 'utf8');
}
function readObj(name, def) {
  try {
    const f = path.join(DATA_DIR, name + '.json');
    if (!fs.existsSync(f)) return def;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) { return def; }
}
function writeObj(name, obj) {
  fs.writeFileSync(path.join(DATA_DIR, name + '.json'), JSON.stringify(obj), 'utf8');
}
function newId(arr) {
  if (!arr.length) return 1;
  return Math.max(...arr.map(x => x.id || 0)) + 1;
}
function nowData() {
  const d = new Date();
  // Zona horaria México UTC-6
  const mxD = new Date(d.getTime() - 6 * 60 * 60 * 1000);
  const dt = mxD.toISOString().slice(0,10);
  const hr = mxD.toISOString().slice(11,19);
  return { dt, hr, day: parseInt(dt.split('-')[2]), mon: parseInt(dt.split('-')[1]), yr: parseInt(dt.split('-')[0]), ts: d.toISOString() };
}

// ── Sesiones activas { celular: { token, ts, nombre } } ───────
// Se guarda en memoria (se limpia al reiniciar) Y en disco
function getSesiones() { return readObj('sesiones', {}); }
function saveSesiones(s) { writeObj('sesiones', s); }

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Limpia sesiones con más de 24h de inactividad
function limpiarSesiones() {
  const s = getSesiones();
  const ahora = Date.now();
  let changed = false;
  Object.keys(s).forEach(cel => {
    if (ahora - s[cel].ts > 24 * 60 * 60 * 1000) { delete s[cel]; changed = true; }
  });
  if (changed) saveSesiones(s);
}

// Valida que el token coincide con la sesión activa
function validarSesion(cel, token) {
  const s = getSesiones();
  if (s[cel] && s[cel].token === token) return true;
  // If no active session (e.g. server restarted), check if user is in accesos as active
  // This prevents locking out users after server restart
  const accesos = readDB('accesos');
  return accesos.some(a => String(a.celular) === String(cel) && a.activo === true);
}

// ── MIME ──────────────────────────────────────────────────────
const MIME = {
  '.html':'text/html; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml',
};

function readBody(req) {
  return new Promise(resolve => {
    let d = '';
    req.on('data', c => { d += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({}); } });
  });
}

function sendJSON(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status||200, {'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Access-Control-Allow-Origin':'*'});
  res.end(body);
}
function sendCSV(res, content, filename) {
  const body = Buffer.from('\uFEFF' + content, 'utf8');
  res.writeHead(200, {'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+filename+'"','Content-Length':body.length});
  res.end(body);
}
function sendFile(res, filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      const idx = path.join(PUBLIC, 'index.html');
      if (fs.existsSync(idx)) return sendFile(res, idx);
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext  = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {'Content-Type':mime,'Content-Length':data.length});
    res.end(data);
  } catch(e) { res.writeHead(500); res.end('Error'); }
}

// ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST,DELETE','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }

  const urlObj   = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;
  const q        = Object.fromEntries(urlObj.searchParams.entries());

  // ── Archivos estáticos ───────────────────────────────────────
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const file = pathname === '/' ? '/index.html' : pathname;
    return sendFile(res, path.join(PUBLIC, file));
  }

  // ── TEST ─────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/test') {
    return sendJSON(res, { ok:true });
  }

  // ═══════════════════════════════════════════════════════════
  // LOGIN — sistema de accesos controlados
  // ═══════════════════════════════════════════════════════════
  if (req.method === 'POST' && pathname === '/api/login') {
    const b = await readBody(req);
    const nombre  = String(b.nombre  || '').trim().toLowerCase();
    const celular = String(b.celular || '').trim();

    if (!nombre || !celular)
      return sendJSON(res, { ok:false, error:'Ingresa nombre y celular.' });

    // Admin siempre puede entrar sin estar en el listado de accesos
    const adminOk = isAdmin(celular, nombre);

    if (!adminOk) {
      // Buscar en listado de accesos creados por admin
      const accesos = readDB('accesos');
      const acceso  = accesos.find(a =>
        String(a.celular).trim() === celular &&
        a.nombre.toLowerCase().trim() === nombre.toLowerCase().trim() &&
        a.activo === true
      );
      if (!acceso) {
        return sendJSON(res, { ok:false, error:'Usuario no autorizado. Pide acceso al administrador.' });
      }
      // Use rol from acceso record
      if (acceso.rol === 'admin' && !adminOk) {
        // treat as admin-level but not superadmin
        // adminOk remains false but we'll set rol below
      }
    }

    limpiarSesiones();
    const sesiones = getSesiones();

    // Verificar si ya hay una sesión activa para este celular
    if (sesiones[celular]) {
      // Si el token viene en el body (re-login del mismo dispositivo), permite
      if (b.token && sesiones[celular].token === b.token) {
        // mismo dispositivo, renovar sesión
        sesiones[celular].ts = Date.now();
        saveSesiones(sesiones);
      } else {
        // Otro dispositivo intentando entrar
        return sendJSON(res, {
          ok: false,
          error: 'Este usuario ya tiene una sesión activa en otro dispositivo.',
          sesionActiva: true
        });
      }
    }

    // Crear sesión nueva
    const token = genToken();
    sesiones[celular] = { token, ts: Date.now(), nombre };
    saveSesiones(sesiones);

    // Guardar/actualizar usuario
    const users = readDB('usuarios');
    let user = users.find(u => String(u.celular) === celular);
    const nombreNorm = nombre.toLowerCase();
    if (!user) { user = { id:newId(users), nombre:nombreNorm, celular, registros:0 }; users.push(user); }
    else user.nombre = nombreNorm;
    writeDB('usuarios', users);

    // Tracking
    const n = nowData();
    const track = readDB('tracking');
    track.push({ id:newId(track), tipo:'apertura_app', usuario_nom:nombre, usuario_cel:celular, fecha:n.dt, hora:n.hr });
    writeDB('tracking', track);

    const adminData = getAdmin(celular, nombre);
    let rol;
    if (adminData) {
      rol = adminData.rol; // superadmin or admin
    } else {
      // Check acceso rol
      const accesos2 = readDB('accesos');
      const acc2 = accesos2.find(a => String(a.celular) === celular);
      rol = (acc2 && acc2.rol === 'admin') ? 'admin' : 'vendedor';
    }
    const isAdminRole = adminOk || rol === 'admin';
    console.log('[LOGIN]', nombre, celular, '('+rol.toUpperCase()+')');
    return sendJSON(res, { ok:true, token, user:{nombre, celular}, admin:isAdminRole, rol });
  }

  // ── LOGOUT — cierra sesión ───────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/logout') {
    const b = await readBody(req);
    const celular = String(b.celular || '').trim();
    const token   = String(b.token   || '').trim();
    const sesiones = getSesiones();
    if (sesiones[celular] && sesiones[celular].token === token) {
      delete sesiones[celular];
      saveSesiones(sesiones);
      console.log('[LOGOUT]', celular);
    }
    return sendJSON(res, { ok:true });
  }

  // ── FORZAR LOGOUT (solo admin) ───────────────────────────────
  if (req.method === 'POST' && pathname === '/api/logout/forzar') {
    const b = await readBody(req);
    if (!isAdmin(q.cel||b.adminCel, q.nom||b.adminNom))
      return sendJSON(res, { ok:false, error:'Sin acceso' });
    const celular = String(b.celular || '').trim();
    const sesiones = getSesiones();
    delete sesiones[celular];
    saveSesiones(sesiones);
    console.log('[FORZAR LOGOUT]', celular);
    return sendJSON(res, { ok:true });
  }

  // ═══════════════════════════════════════════════════════════
  // GESTIÓN DE ACCESOS (solo admin)
  // ═══════════════════════════════════════════════════════════

  // Listar accesos
  if (req.method === 'GET' && pathname === '/api/accesos') {
    if (!isAdmin(q.cel, q.nom)) return sendJSON(res, { error:'Sin acceso' }, 403);
    const accesos  = readDB('accesos');
    const sesiones = getSesiones();
    // Agregar si tiene sesión activa
    const result = accesos.map(a => ({
      ...a,
      enLinea: !!sesiones[String(a.celular)]
    }));
    return sendJSON(res, result);
  }

  // Crear acceso
  if (req.method === 'POST' && pathname === '/api/accesos') {
    const b = await readBody(req);
    if (!isAdmin(b.adminCel, b.adminNom)) return sendJSON(res, { error:'Sin acceso' }, 403);
    const nombre  = String(b.nombre  || '').trim().toLowerCase();
    const celular = String(b.celular || '').trim();
    if (!nombre || !celular) return sendJSON(res, { ok:false, error:'Nombre y celular requeridos.' });
    const accesos = readDB('accesos');
    if (accesos.find(a => String(a.celular) === celular))
      return sendJSON(res, { ok:false, error:'Ya existe un acceso con ese celular.' });
    const rolAcc = String(b.rol||'usuario') === 'admin' ? 'admin' : 'usuario';
    const nuevo = { id:newId(accesos), nombre:nombre.toLowerCase(), celular, activo:true, rol:rolAcc, creado: new Date().toISOString() };
    accesos.push(nuevo);
    writeDB('accesos', accesos);
    console.log('[ACCESO CREADO]', nombre, celular);
    return sendJSON(res, { ok:true, acceso:nuevo });
  }

  // Activar / desactivar acceso
  if (req.method === 'POST' && pathname === '/api/accesos/toggle') {
    const b = await readBody(req);
    if (!canManageAccesos(b.adminCel, b.adminNom)) return sendJSON(res, { ok:false, error:'Solo el administrador principal puede activar o desactivar asesores.' });
    const accesos = readDB('accesos');
    const acc = accesos.find(a => String(a.celular) === String(b.celular));
    if (!acc) return sendJSON(res, { ok:false, error:'No encontrado.' });
    acc.activo = !acc.activo;
    // Si se desactiva, cerrar sesión activa
    if (!acc.activo) {
      const sesiones = getSesiones();
      delete sesiones[String(b.celular)];
      saveSesiones(sesiones);
    }
    writeDB('accesos', accesos);
    console.log('[TOGGLE ACCESO]', acc.nombre, acc.activo ? 'activado' : 'desactivado');
    return sendJSON(res, { ok:true, activo:acc.activo });
  }

  // Eliminar acceso
  if (req.method === 'POST' && pathname === '/api/accesos/eliminar') {
    const b = await readBody(req);
    if (!canManageAccesos(b.adminCel, b.adminNom)) return sendJSON(res, { ok:false, error:'Solo el administrador principal puede eliminar asesores.' });
    let accesos = readDB('accesos');
    accesos = accesos.filter(a => String(a.celular) !== String(b.celular));
    writeDB('accesos', accesos);
    const sesiones = getSesiones();
    delete sesiones[String(b.celular)];
    saveSesiones(sesiones);
    console.log('[ACCESO ELIMINADO]', b.celular);
    return sendJSON(res, { ok:true });
  }

  // ═══════════════════════════════════════════════════════════
  // REGISTROS
  // ═══════════════════════════════════════════════════════════
  if (req.method === 'POST' && pathname === '/api/registros') {
    const b = await readBody(req);
    // Validar sesión activa
    if (!isAdmin(b.usuario_cel, b.usuario_nom) && !validarSesion(b.usuario_cel, b.token))
      return sendJSON(res, { ok:false, error:'Sesión no válida.' });

    const regs = readDB('registros');
    const reg = {
      id:newId(regs), codigo:b.codigo, descripcion:b.descripcion||'', familia:b.familia||'',
      tipo:b.tipo, distribuidor:b.distribuidor, piezas:b.piezas||1, desc_cliente:b.desc_cliente||'',
      usuario_cel:String(b.usuario_cel), usuario_nom:b.usuario_nom||'',
      fecha:b.fecha, hora:b.hora, dia:b.dia, mes:b.mes, anio:b.anio, ts:b.ts||new Date().toISOString()
    };
    regs.push(reg);
    writeDB('registros', regs);
    const users = readDB('usuarios');
    const u = users.find(x => String(x.celular) === String(b.usuario_cel));
    if (u) { u.registros=(u.registros||0)+1; writeDB('usuarios',users); }
    const n = nowData();
    const track = readDB('tracking');
    track.push({ id:newId(track), tipo:'alta_registro', usuario_nom:b.usuario_nom, usuario_cel:String(b.usuario_cel), fecha:b.fecha, hora:b.hora });
    writeDB('tracking',track);
    console.log('[REGISTRO]', b.codigo, b.tipo, b.usuario_nom);
    // If tipo=vendido, also save to ventas table
    if (b.tipo === 'vendido') {
      const ventas = readDB('ventas');
      ventas.push({ id:newId(ventas), codigo:b.codigo, descripcion:b.descripcion||'', familia:b.familia||'', piezas:b.piezas||1, usuario_cel:String(b.usuario_cel), usuario_nom:b.usuario_nom||'', fecha:b.fecha, hora:b.hora, dia:b.dia, mes:b.mes, anio:b.anio, ts:b.ts||new Date().toISOString() });
      writeDB('ventas', ventas);
    }
    return sendJSON(res, { ok:true, id:reg.id });
  }

  if (req.method === 'GET' && pathname === '/api/registros') {
    const admin = isAdmin(q.cel, q.nom);
    let rows = readDB('registros');
    if (!admin) rows = rows.filter(r => String(r.usuario_cel) === String(q.cel));
    else if (q.vendedor) rows = rows.filter(r => String(r.usuario_cel) === String(q.vendedor));
    if (q.tipo)         rows = rows.filter(r => r.tipo === q.tipo);
    if (q.distribuidor) rows = rows.filter(r => r.distribuidor === q.distribuidor);
    if (q.dia)  rows = rows.filter(r => Number(r.dia)  === Number(q.dia));
    if (q.mes)  rows = rows.filter(r => Number(r.mes)  === Number(q.mes));
    if (q.anio) rows = rows.filter(r => Number(r.anio) === Number(q.anio));
    rows = rows.slice().reverse();
    if (q.limit) rows = rows.slice(0, Number(q.limit));
    return sendJSON(res, rows);
  }

  // ── UPLOAD DATA (temporal) ──────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/upload-data') {
    const b = await readBody(req);
    if (b.secret !== 'negados2026') return sendJSON(res, { ok: false, error: 'No autorizado' });
    if (!b.archivo || !b.datos) return sendJSON(res, { ok: false, error: 'Faltan datos' });
    writeDB(b.archivo, b.datos);
    return sendJSON(res, { ok: true, total: b.datos.length });
  }

  // ── STATS ────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/stats') {
    const admin = isAdmin(q.cel, q.nom);
    let all = readDB('registros');
    if (!admin) all = all.filter(r => String(r.usuario_cel) === String(q.cel));
    else if (q.vendedor) all = all.filter(r => String(r.usuario_cel) === String(q.vendedor));
    const nd=new Date();
    const today = q.fecha ? q.fecha : new Date(nd.getTime() - 6*60*60*1000).toISOString().slice(0,10);
    const mesActual = today.split('-')[1] ? parseInt(today.split('-')[1]) : nd.getMonth()+1;
    const anioActual = today.split('-')[0] ? parseInt(today.split('-')[0]) : nd.getFullYear();
    const hoy=all.filter(r=>r.fecha===today);
    const mesR=all.filter(r=>Number(r.mes)===mesActual&&Number(r.anio)===anioActual);
    const sum=arr=>arr.reduce((s,r)=>s+(r.piezas||1),0);
    const siH=hoy.filter(r=>r.distribuidor==='si'); const noH=hoy.filter(r=>r.distribuidor!=='si');
    const siM=mesR.filter(r=>r.distribuidor==='si'); const noM=mesR.filter(r=>r.distribuidor!=='si');
    // Charts always show data for the selected day (or today if no day selected)
    const chartSrc = hoy;
    const famCt=dist=>{const ct={};chartSrc.filter(r=>r.distribuidor===dist).forEach(r=>{ct[r.familia]=(ct[r.familia]||0)+1;});return Object.entries(ct).sort((a,b)=>b[1]-a[1]).slice(0,8);};
    const codCt=dist=>{const ct={},pz={},ult={};chartSrc.filter(r=>r.distribuidor===dist).forEach(r=>{ct[r.codigo]=(ct[r.codigo]||0)+1;pz[r.codigo]=(pz[r.codigo]||0)+(r.piezas||1);ult[r.codigo]={nom:r.usuario_nom,fecha:r.fecha};});return Object.entries(ct).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([codigo,count])=>({codigo,count,piezas:pz[codigo]||0,nom:ult[codigo]?ult[codigo].nom:'',fecha:ult[codigo]?ult[codigo].fecha:''}));};
    const dias=[];
    for(let i=13;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const ds=d.toISOString().slice(0,10);const p=ds.split('-');const dr=all.filter(r=>r.fecha===ds);dias.push({label:p[2]+'/'+p[1],si:dr.filter(r=>r.distribuidor==='si').length,no:dr.filter(r=>r.distribuidor!=='si').length,pzSi:dr.filter(r=>r.distribuidor==='si').reduce((s,r)=>s+(r.piezas||1),0),pzNo:dr.filter(r=>r.distribuidor!=='si').reduce((s,r)=>s+(r.piezas||1),0)});}
    return sendJSON(res,{stats:{siHoy:siH.length,pzSiHoy:sum(siH),noHoy:noH.length,pzNoHoy:sum(noH),siMes:siM.length,pzSiMes:sum(siM),noMes:noM.length,pzNoMes:sum(noM),codigosUnicos:new Set(all.map(r=>r.codigo)).size,totalRegs:all.length},famSi:famCt('si'),famNo:famCt('no'),codSi:codCt('si'),codNo:codCt('no'),dias});
  }

  // ── MERCH POST ───────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/merch') {
    const b = await readBody(req);
    if (!isAdmin(b.usuario_cel, b.usuario_nom) && !validarSesion(b.usuario_cel, b.token))
      return sendJSON(res, { ok:false, error:'Sesión no válida.' });
    const merch=readDB('merch');
    const reg={id:newId(merch),codigo:b.codigo,familia:b.familia||'',resultado:b.resultado,motivo:b.motivo||'',competencia:b.competencia||'',precio_competencia:b.precio_competencia||'',usuario_cel:String(b.usuario_cel),usuario_nom:b.usuario_nom||'',fecha:b.fecha,hora:b.hora,dia:b.dia,mes:b.mes,anio:b.anio,ts:b.ts||new Date().toISOString()};
    merch.push(reg); writeDB('merch',merch);
    const n=nowData(); const track=readDB('tracking');
    track.push({id:newId(track),tipo:'merch_'+b.resultado,usuario_nom:b.usuario_nom,usuario_cel:String(b.usuario_cel),fecha:b.fecha,hora:b.hora});
    writeDB('tracking',track);
    return sendJSON(res,{ok:true,id:reg.id});
  }

  if (req.method === 'GET' && pathname === '/api/merch') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('merch');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.dia)  rows=rows.filter(r=>Number(r.dia) ===Number(q.dia));
    if(q.mes)  rows=rows.filter(r=>Number(r.mes) ===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    rows=rows.slice().reverse();
    if(q.limit) rows=rows.slice(0,Number(q.limit));
    return sendJSON(res,rows);
  }

  // ── MERCH STATS ──────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/merch/stats') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('merch');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    if(q.vendedor&&admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.fecha) rows=rows.filter(r=>r.fecha===q.fecha);
    else {
      if(q.dia)  rows=rows.filter(r=>Number(r.dia) ===Number(q.dia));
      if(q.mes)  rows=rows.filter(r=>Number(r.mes) ===Number(q.mes));
      if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    }
    const ac=rows.filter(r=>r.resultado==='acepto').length;
    const re=rows.filter(r=>r.resultado==='rechazo').length;
    const motAc={},motRe={};
    rows.filter(r=>r.resultado==='acepto').forEach(r=>{if(r.motivo)motAc[r.motivo]=(motAc[r.motivo]||0)+1;});
    rows.filter(r=>r.resultado==='rechazo').forEach(r=>{if(r.motivo)motRe[r.motivo]=(motRe[r.motivo]||0)+1;});
    const porFam={};
    rows.forEach(r=>{if(!porFam[r.familia])porFam[r.familia]={acepto:0,rechazo:0};porFam[r.familia][r.resultado]++;});
    // Competencia: which competitor codes are being bought from (precio rechazo)
    const compCt={}, compCod={};
    rows.filter(r=>r.resultado==='rechazo'&&r.motivo==='precio'&&r.competencia).forEach(r=>{
      compCt[r.competencia]=(compCt[r.competencia]||0)+1;
      if(!compCod[r.competencia]) compCod[r.competencia]={};
      if(!compCod[r.competencia][r.codigo]) compCod[r.competencia][r.codigo]={cnt:0,precios:[]};
      compCod[r.competencia][r.codigo].cnt++;
      if(r.precio_competencia) compCod[r.competencia][r.codigo].precios.push(parseFloat(r.precio_competencia)||0);
    });
    const competencia=Object.entries(compCt).sort((a,b)=>b[1]-a[1]);
    const codxComp={};
    Object.keys(compCod).forEach(comp=>{
      codxComp[comp]=Object.entries(compCod[comp]).sort((a,b)=>b[1].cnt-a[1].cnt).slice(0,10).map(([cod,d])=>({cod,cnt:d.cnt,avgPrecio:d.precios.length?Math.round(d.precios.reduce((s,v)=>s+v,0)/d.precios.length*100)/100:null}));
    });
    const dias=[];
    for(let i=13;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const ds=d.toISOString().slice(0,10);const p=ds.split('-');const dr=rows.filter(r=>r.fecha===ds);dias.push({label:p[2]+'/'+p[1],acepto:dr.filter(r=>r.resultado==='acepto').length,rechazo:dr.filter(r=>r.resultado==='rechazo').length});}
    return sendJSON(res,{total:rows.length,acepto:ac,rechazo:re,motivosAcepto:Object.entries(motAc).sort((a,b)=>b[1]-a[1]),motivosRechazo:Object.entries(motRe).sort((a,b)=>b[1]-a[1]),porFamilia:Object.entries(porFam).sort((a,b)=>(b[1].acepto+b[1].rechazo)-(a[1].acepto+a[1].rechazo)).slice(0,10),competencia,codxComp,dias});
  }

  // ── USUARIOS ─────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/usuarios') {
    if(!isAdmin(q.cel,q.nom)) return sendJSON(res,{error:'Sin acceso'},403);
    const regs=readDB('registros');
    const sesiones=getSesiones();
    return sendJSON(res,readDB('usuarios').map(u=>({...u,registros:regs.filter(r=>String(r.usuario_cel)===String(u.celular)).length,enLinea:!!sesiones[String(u.celular)]})));
  }

  // ── TRACKING ─────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/tracking') {
    if(!isAdmin(q.cel,q.nom)) return sendJSON(res,{error:'Sin acceso'},403);
    return sendJSON(res,readDB('tracking').slice().reverse().slice(0,500));
  }

  // ── EXPORT REGISTROS ─────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/registros') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('registros');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.tipo) rows=rows.filter(r=>r.tipo===q.tipo);
    if(q.distribuidor) rows=rows.filter(r=>r.distribuidor===q.distribuidor);
    if(q.dia) rows=rows.filter(r=>Number(r.dia)===Number(q.dia));
    if(q.mes) rows=rows.filter(r=>Number(r.mes)===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    const lines=['ID,Codigo,Descripcion,Familia,Tipo,Distribuidor,Piezas,Usuario,Celular,Fecha,Hora'];
    rows.forEach(r=>lines.push([r.id,r.codigo,'"'+(r.descripcion||'').replace(/"/g,'""')+'"',r.familia,r.tipo,r.distribuidor,r.piezas||1,r.usuario_nom,r.usuario_cel,r.fecha,r.hora].join(',')));
    return sendCSV(res,lines.join('\r\n'),'registros.csv');
  }

  // ── EXPORT MERCH ─────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/merch') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('merch');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.dia) rows=rows.filter(r=>Number(r.dia)===Number(q.dia));
    if(q.mes) rows=rows.filter(r=>Number(r.mes)===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    const lines=['ID,Codigo,Familia,Resultado,Motivo,Competencia,Usuario,Celular,Fecha,Hora'];
    rows.forEach(r=>lines.push([r.id,r.codigo,'"'+(r.familia||'')+'"',r.resultado,r.motivo||'',r.competencia||'',r.usuario_nom,r.usuario_cel,r.fecha,r.hora].join(',')));
    return sendCSV(res,lines.join('\r\n'),'merch.csv');
  }

  // ── EXPORT FAMILIAS ──────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/familias') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('registros');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.dia) rows=rows.filter(r=>Number(r.dia)===Number(q.dia));
    if(q.mes) rows=rows.filter(r=>Number(r.mes)===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    const ct={};
    rows.forEach(r=>{const k=r.familia||'Sin familia';if(!ct[k])ct[k]={familia:k,si:0,no:0,pzSi:0,pzNo:0,total:0};if(r.distribuidor==='si'){ct[k].si++;ct[k].pzSi+=(r.piezas||1);}else{ct[k].no++;ct[k].pzNo+=(r.piezas||1);}ct[k].total++;});
    const sorted=Object.values(ct).sort((a,b)=>b.total-a.total);
    const lines=['Familia,Si_Maneja,Pzas_Si,No_Maneja,Pzas_No,Total'];
    sorted.forEach(r=>lines.push(['"'+r.familia+'"',r.si,r.pzSi,r.no,r.pzNo,r.total].join(',')));
    return sendCSV(res,lines.join('\r\n'),'familias.csv');
  }

  // ── EXPORT CODIGOS ───────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/codigos') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('registros');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.dia) rows=rows.filter(r=>Number(r.dia)===Number(q.dia));
    if(q.mes) rows=rows.filter(r=>Number(r.mes)===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    const ct={};
    rows.forEach(r=>{if(!ct[r.codigo])ct[r.codigo]={codigo:r.codigo,desc:r.descripcion||'',fam:r.familia||'',si:0,no:0,pzSi:0,pzNo:0,total:0};if(r.distribuidor==='si'){ct[r.codigo].si++;ct[r.codigo].pzSi+=(r.piezas||1);}else{ct[r.codigo].no++;ct[r.codigo].pzNo+=(r.piezas||1);}ct[r.codigo].total++;});
    const sorted=Object.values(ct).sort((a,b)=>b.total-a.total);
    const lines=['Codigo,Descripcion,Familia,Si_Maneja,Pzas_Si,No_Maneja,Pzas_No,Total'];
    sorted.forEach(r=>lines.push([r.codigo,'"'+r.desc.replace(/"/g,'""')+'"','"'+r.fam+'"',r.si,r.pzSi,r.no,r.pzNo,r.total].join(',')));
    return sendCSV(res,lines.join('\r\n'),'codigos.csv');
  }


  // ── API: ventas POST ─────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/api/ventas') {
    const b = await readBody(req);
    if (!isAdmin(b.usuario_cel, b.usuario_nom) && !validarSesion(b.usuario_cel, b.token))
      return sendJSON(res, { ok:false, error:'Sesión no válida.' });
    const ventas = readDB('ventas');
    const reg = {
      id:newId(ventas), codigo:b.codigo, descripcion:b.descripcion||'', familia:b.familia||'',
      piezas:b.piezas||1, usuario_cel:String(b.usuario_cel), usuario_nom:b.usuario_nom||'',
      fecha:b.fecha, hora:b.hora, dia:b.dia, mes:b.mes, anio:b.anio, ts:b.ts||new Date().toISOString()
    };
    ventas.push(reg);
    writeDB('ventas', ventas);
    const n=nowData();
    const track=readDB('tracking');
    track.push({id:newId(track),tipo:'venta',usuario_nom:b.usuario_nom,usuario_cel:String(b.usuario_cel),fecha:b.fecha,hora:b.hora});
    writeDB('tracking',track);
    console.log('[VENTA]', b.codigo, b.piezas, b.usuario_nom);
    return sendJSON(res, {ok:true, id:reg.id});
  }

  // ── API: ventas GET ──────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/ventas') {
    const admin = isAdmin(q.cel, q.nom);
    let rows = readDB('ventas');
    if (!admin) rows = rows.filter(r => String(r.usuario_cel) === String(q.cel));
    else if (q.vendedor) rows = rows.filter(r => String(r.usuario_cel) === String(q.vendedor));
    if (q.dia)  rows = rows.filter(r => Number(r.dia)  === Number(q.dia));
    if (q.mes)  rows = rows.filter(r => Number(r.mes)  === Number(q.mes));
    if (q.anio) rows = rows.filter(r => Number(r.anio) === Number(q.anio));
    rows = rows.slice().reverse();
    if (q.limit) rows = rows.slice(0, Number(q.limit));
    return sendJSON(res, rows);
  }

  // ── API: export ventas ───────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/ventas') {
    const admin = isAdmin(q.cel, q.nom);
    let rows = readDB('ventas');
    if (!admin) rows = rows.filter(r => String(r.usuario_cel) === String(q.cel));
    else if (q.vendedor) rows = rows.filter(r => String(r.usuario_cel) === String(q.vendedor));
    if (q.dia)  rows = rows.filter(r => Number(r.dia)  === Number(q.dia));
    if (q.mes)  rows = rows.filter(r => Number(r.mes)  === Number(q.mes));
    if (q.anio) rows = rows.filter(r => Number(r.anio) === Number(q.anio));
    const lines = ['ID,Codigo,Descripcion,Familia,Piezas,Usuario,Celular,Fecha,Hora'];
    rows.forEach(r => lines.push([r.id,r.codigo,'"'+(r.descripcion||'').replace(/"/g,'""')+'"',r.familia,r.piezas||1,r.usuario_nom,r.usuario_cel,r.fecha,r.hora].join(',')));
    return sendCSV(res, lines.join('\r\n'), 'ventas.csv');
  }

  // ── API: registros tipo=vendido (from captura screen) ────────
  // Vendido type registros are stored in main registros table with tipo='vendido'
  // They are also stored in ventas table separately for easy export


  // ── API: export competencia ──────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/export/competencia') {
    const admin=isAdmin(q.cel,q.nom);
    let rows=readDB('merch');
    if(!admin) rows=rows.filter(r=>String(r.usuario_cel)===String(q.cel));
    else if(q.vendedor) rows=rows.filter(r=>String(r.usuario_cel)===String(q.vendedor));
    if(q.dia) rows=rows.filter(r=>Number(r.dia)===Number(q.dia));
    if(q.mes) rows=rows.filter(r=>Number(r.mes)===Number(q.mes));
    if(q.anio) rows=rows.filter(r=>Number(r.anio)===Number(q.anio));
    // Only precio rechazo with competencia
    const filtered=rows.filter(r=>r.resultado==='rechazo'&&r.motivo==='precio'&&r.competencia);
    const lines=['Codigo,Familia,Competencia,Precio_Competencia,Usuario,Celular,Fecha,Hora'];
    filtered.forEach(r=>lines.push([r.codigo,'"'+(r.familia||'')+'"',r.competencia,r.precio_competencia||'',r.usuario_nom,r.usuario_cel,r.fecha,r.hora].join(',')));
    return sendCSV(res,lines.join('\r\n'),'competencia.csv');
  }

  // ── 404 ──────────────────────────────────────────────────────
  sendJSON(res,{error:'Not found'},404);
});

server.listen(PORT, () => {
  console.log('');
  console.log('==========================================');
  console.log('  NegadosApp IUSA corriendo en:');
  console.log('  http://localhost:' + PORT);
  console.log('==========================================');
  console.log('  Admins: ' + ADMINS.map(a=>a.nom+' / '+a.cel).join(' | '));
  console.log('  Datos: ' + DATA_DIR);
  console.log('==========================================');
  console.log('');
});
