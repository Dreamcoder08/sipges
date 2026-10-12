from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Query, Request
from fastapi.responses import HTMLResponse, FileResponse, StreamingResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pathlib import Path
from typing import Any, Dict, Optional
import sqlite3, json, uuid, datetime, re, unicodedata, os, mimetypes, hashlib, secrets, hmac, time, base64, struct, contextvars

BASE = Path(__file__).resolve().parent
DB = Path(os.getenv("MASCLI_DB_PATH", str(BASE / "data" / "mascli.db")))
SEED = BASE / "data" / "seed.json"
IRSA_CONFIG = BASE / "data" / "irsa_config.json"
INDICATOR_CONFIG = BASE / "data" / "indicator_config.json"
MODEL_STATUS = BASE / "data" / "model_status.json"
CANONICAL_ENTITIES = BASE / "data" / "canonical_entities.json"
PROJECT_COORDINATES = BASE / "data" / "project_coordinates.json"
UPLOAD_DIR = Path(os.getenv("MASCLI_UPLOAD_DIR", str(BASE / "data" / "uploads")))
MAX_UPLOAD_BYTES = int(os.getenv("MASCLI_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
ALLOWED_UPLOAD_EXTENSIONS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".jpg", ".jpeg", ".png", ".webp", ".txt"}

MODULES = {
    "eventos":"Eventos","actores":"Actores","demandas":"Demandas","compromisos":"Compromisos",
    "narrativas":"Narrativas","fuentes":"Fuentes","indicadores":"Indicadores","alertas":"Alertas",
    "acciones":"Acciones","directorio":"Directorio_Territorial","priorizados":"Actores_Priorizados",
    "usuarios":"Usuarios","roles":"Roles","proyectos":"Proyectos",
    "intereses":"Intereses","dialogos":"Dialogos","oportunidades":"Oportunidades",
    "hechos":"Hechos_Compartidos","aarc":"Evaluaciones_AARC"
}

app = FastAPI(title="MASCLI – Gestión Territorial Empresarial", version="3.0.0-rc")
app.mount("/static", StaticFiles(directory=BASE/"static"), name="static")

class RecordIn(BaseModel):
    payload: Dict[str, Any]

SCOPE_DB=contextvars.ContextVar('mascli_scope_db',default=None)
SCOPE_ID=contextvars.ContextVar('mascli_scope_id',default=None)
AUTH_DB=Path(os.getenv('MASCLI_AUTH_DB_PATH',str(BASE/'data'/'auth_global.db')))
TENANT_DIR=Path(os.getenv('MASCLI_TENANT_DIR',str(BASE/'data'/'tenants')))

def auth_conn():
    AUTH_DB.parent.mkdir(parents=True,exist_ok=True)
    c=sqlite3.connect(AUTH_DB)
    c.row_factory=sqlite3.Row
    return c

def conn():
    c=sqlite3.connect(SCOPE_DB.get() or DB)
    c.row_factory=sqlite3.Row
    return c

def upload_root():
    scope=SCOPE_ID.get()
    if not scope or scope==('MASCLI','PRJ-SECHURA'):return UPLOAD_DIR
    return UPLOAD_DIR/hashlib.sha256((scope[0]+'/'+scope[1]).encode()).hexdigest()[:24]

def now():
    return datetime.datetime.now().isoformat(timespec="seconds")

def rid_for(module, payload):
    keys = {
        "Eventos":"ID_Evento","Actores":"ID_Actor","Demandas":"ID_Demanda","Compromisos":"ID_Compromiso",
        "Narrativas":"ID_Narrativa","Fuentes":"ID_Fuente","Indicadores":"Codigo","Alertas":"ID_Alerta",
        "Acciones":"ID_Accion","Usuarios":"ID_Usuario","Roles":"ID_Rol","Proyectos":"Proyecto_ID"
    }
    k=keys.get(module)
    if k and payload.get(k):
        return str(payload[k])
    prefix={"Eventos":"EV","Actores":"A","Demandas":"D","Alertas":"AL","Fuentes":"F","Usuarios":"USR","Roles":"ROL","Proyectos":"PRJ"}.get(module,module[:3].upper())
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"

def init_db():
    DB.parent.mkdir(parents=True, exist_ok=True)
    c=conn()
    c.execute("""CREATE TABLE IF NOT EXISTS records(
        module TEXT NOT NULL,
        record_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(module,record_id)
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL, module TEXT NOT NULL, record_id TEXT,
        action TEXT NOT NULL, detail TEXT
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS irsa_snapshots(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        irsa REAL NOT NULL,
        level TEXT NOT NULL,
        scores TEXT NOT NULL,
        config_version TEXT,
        note TEXT
    )""")
    c.execute("""CREATE TABLE IF NOT EXISTS attachments(
        id TEXT PRIMARY KEY,
        stored_name TEXT NOT NULL,
        original_name TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT,
        linked_module TEXT NOT NULL,
        linked_record_id TEXT NOT NULL,
        document_type TEXT,
        author TEXT,
        verification TEXT,
        notes TEXT,
        project_id TEXT,
        project_name TEXT,
        created_at TEXT NOT NULL
    )""")
    attachment_columns_PLACEHOLDER = None
    attachment_columns={r["name"] for r in c.execute("PRAGMA table_info(attachments)").fetchall()}
    if "project_id" not in attachment_columns: c.execute("ALTER TABLE attachments ADD COLUMN project_id TEXT")
    if "project_name" not in attachment_columns: c.execute("ALTER TABLE attachments ADD COLUMN project_name TEXT")
    count=c.execute("SELECT COUNT(*) n FROM records").fetchone()["n"]
    if count==0:
        data=json.loads(SEED.read_text(encoding="utf-8"))
        for module,items in data.items():
            for item in items:
                rid=rid_for(module,item)
                c.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)",
                          (module,rid,json.dumps(item,ensure_ascii=False),now(),now()))
        c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",
                  (now(),"Sistema",None,"SEED","Base Maestra octubre 2026 importada"))
    # Datos mínimos del prototipo administrativo. No representan cuentas autenticadas.
    if c.execute("SELECT COUNT(*) n FROM records WHERE module='Roles'").fetchone()["n"] == 0:
        roles=[
            {"ID_Rol":"ROL-ADMIN","Nombre":"Administrador","Descripcion":"Configuración y gestión del prototipo","Permisos":"Todos los módulos"},
            {"ID_Rol":"ROL-ANALISTA","Nombre":"Analista","Descripcion":"Registro, análisis y validación de información","Permisos":"Base Maestra y análisis"},
            {"ID_Rol":"ROL-COORD","Nombre":"Coordinador territorial","Descripcion":"Seguimiento territorial y directorio","Permisos":"Consulta y seguimiento"},
            {"ID_Rol":"ROL-CONSULTA","Nombre":"Consulta","Descripcion":"Lectura de información autorizada","Permisos":"Solo lectura"},
        ]
        for item in roles:
            c.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)",("Roles",item["ID_Rol"],json.dumps(item,ensure_ascii=False),now(),now()))
    if c.execute("SELECT COUNT(*) n FROM records WHERE module='Usuarios'").fetchone()["n"] == 0:
        users=[
            {"ID_Usuario":"USR-001","Nombre":"Crystell Granda","Cargo":"Administración del prototipo","Correo":"","Rol":"Administrador","Estado":"Activo","Ultimo_Acceso":"No disponible"},
            {"ID_Usuario":"USR-002","Nombre":"Analista de demostración","Cargo":"Analista socioambiental","Correo":"","Rol":"Analista","Estado":"Inactivo","Ultimo_Acceso":"No disponible"},
        ]
        for item in users:
            c.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)",("Usuarios",item["ID_Usuario"],json.dumps(item,ensure_ascii=False),now(),now()))
    if c.execute("SELECT COUNT(*) n FROM records WHERE module='Proyectos'").fetchone()["n"] == 0:
        project={"Proyecto_ID":"PRJ-SECHURA","Nombre":"Proyecto Sechura","Territorio":"Sechura, Piura","Estado":"Activo","Descripcion":"Proyecto predeterminado de la Base Maestra MASCLI","Fecha_Creacion":"2026-10-10"}
        c.execute("INSERT OR IGNORE INTO records VALUES(?,?,?,?,?)",("Proyectos",project["Proyecto_ID"],json.dumps(project,ensure_ascii=False),now(),now()))
    c.commit(); c.close()

# MASCLI RC 2.9: sesiones opacas y roles efectivos. Una instalación = una organización.
AUTH_ROLES={"admin","analista","coordinador","consulta"}
COOKIE_NAME="mascli_session"
SESSION_SECONDS=8*3600

def hash_password(password):
    salt=secrets.token_bytes(16)
    derived=hashlib.pbkdf2_hmac("sha256",password.encode(),salt,310000)
    return "pbkdf2_sha256$310000$"+salt.hex()+"$"+derived.hex()

def verify_password(password, stored):
    try:
        algorithm,iterations,salt,digest=stored.split("$")
        if algorithm!="pbkdf2_sha256": return False
        candidate=hashlib.pbkdf2_hmac("sha256",password.encode(),bytes.fromhex(salt),int(iterations))
        return hmac.compare_digest(candidate,bytes.fromhex(digest))
    except (ValueError,TypeError): return False

def totp_code(secret, at=None):
    key=base64.b32decode(secret+'='*((-len(secret))%8))
    counter=int((at if at is not None else time.time())//30)
    digest=hmac.new(key,struct.pack('>Q',counter),hashlib.sha1).digest()
    offset=digest[-1]&15
    value=(struct.unpack('>I',digest[offset:offset+4])[0]&0x7fffffff)%1000000
    return f'{value:06d}'

def totp_ok(secret,code):
    return bool(re.fullmatch(r'\d{6}',code or '')) and any(hmac.compare_digest(totp_code(secret,time.time()+i*30),code) for i in (-1,0,1))

def auth_identity(request):
    token=request.cookies.get(COOKIE_NAME,"")
    if len(token)!=64: return None
    c=auth_conn()
    row=c.execute("SELECT u.username,u.full_name,u.role,u.active FROM auth_sessions s JOIN auth_users u ON u.username=s.username WHERE s.token_hash=? AND s.expires_at>?",(hashlib.sha256(token.encode()).hexdigest(),int(time.time()))).fetchone()
    c.close()
    return dict(row) if row and row['active'] else None

@app.middleware("http")
async def enforce_auth(request:Request, call_next):
    path=request.url.path
    if path in ('/health','/login','/logout','/select-project') or path in ('/system/auth/me','/system/auth/scopes'):
        return await call_next(request)
    identity=auth_identity(request)
    if not identity:
        if path=='/' and request.method=='GET': return RedirectResponse('/login',status_code=303)
        return JSONResponse({'detail':'Inicie sesión para acceder a MASCLI'},status_code=401)
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        host=request.headers.get('host')
        if origin:
            from urllib.parse import urlsplit
            if urlsplit(origin).netloc != host:
                return JSONResponse({'detail':'Origen de solicitud no permitido'},status_code=403)
    ac=auth_conn()
    grants=ac.execute('SELECT company_id,project_id FROM access_grants WHERE username=?',(identity['username'],)).fetchall()
    ac.close()
    target=request.headers.get('X-MASCLI-Scope','') or request.cookies.get('mascli_scope','')
    if not target and len(grants)==1:
        target=grants[0]['company_id']+'/'+grants[0]['project_id']
    if not target or target not in [g['company_id']+'/'+g['project_id'] for g in grants]:
        if path=='/' and request.method=='GET':return RedirectResponse('/select-project',status_code=303)
        return JSONResponse({'detail':'Seleccione un proyecto autorizado mediante X-MASCLI-Scope o /select-project','projects':[g['company_id']+'/'+g['project_id'] for g in grants]},status_code=403)
    company_id,project_id=target.split('/',1)
    scope_hash=hashlib.sha256(target.encode()).hexdigest()[:24]
    scoped_path=DB if target=='MASCLI/PRJ-SECHURA' else TENANT_DIR/(scope_hash+'.db')
    if not scoped_path.exists():return JSONResponse({'detail':'Base del proyecto no inicializada'},status_code=503)
    tok=SCOPE_DB.set(scoped_path); sid=SCOPE_ID.set((company_id,project_id))
    # Proyecto/empresa enviados por cliente no pueden sustituir el alcance autenticado.
    requested_project=request.query_params.get('project_id')
    if requested_project and requested_project!=project_id:
        SCOPE_DB.reset(tok);SCOPE_ID.reset(sid)
        return JSONResponse({'detail':'Proyecto fuera de alcance'},status_code=403)
    if request.method in ('POST','PUT','PATCH') and (path.startswith('/api/') or path.startswith('/system/')):
        if request.headers.get('content-type','').startswith('application/json'):
            raw=await request.body()
            try: obj=json.loads(raw)
            except (ValueError,UnicodeDecodeError):obj={}
            if isinstance(obj,dict):
                supplied=obj.get('project_id') or (obj.get('payload') or {}).get('Proyecto_ID') or (obj.get('payload') or {}).get('project_id')
                if supplied and supplied!=project_id:
                    SCOPE_DB.reset(tok);SCOPE_ID.reset(sid)
                    return JSONResponse({'detail':'No se permite escribir en otro proyecto'},status_code=403)
    role=identity['role']; method=request.method
    if path.startswith('/system/auth/accounts') and role!='admin':
        return JSONResponse({'detail':'Administración de cuentas restringida'},status_code=403)
    if path.startswith('/system/export') or path.startswith('/system/audit') or path.startswith('/system/irsa/config') and method!='GET':
        if role!='admin': return JSONResponse({'detail':'Requiere rol administrador'},status_code=403)
    if path.startswith('/api/usuarios') or path.startswith('/api/roles'):
        if role!='admin': return JSONResponse({'detail':'Acceso administrativo requerido'},status_code=403)
    if path.startswith('/api/proyectos') and method!='GET' and role!='admin':
        return JSONResponse({'detail':'Solo el administrador puede gestionar proyectos'},status_code=403)
    if method not in ('GET','HEAD','OPTIONS'):
        if role=='consulta': return JSONResponse({'detail':'Rol de consulta: solo lectura'},status_code=403)
        if role=='coordinador' and not (path.startswith('/system/prevention/') or path.startswith('/system/intelligence/territorial-alerts')):
            return JSONResponse({'detail':'Operación restringida para coordinador'},status_code=403)
    try:
        response=await call_next(request)
    finally:
        SCOPE_DB.reset(tok);SCOPE_ID.reset(sid)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['Cache-Control']='no-store'
    return response

@app.get('/login',response_class=HTMLResponse)
def login_page():
    return HTMLResponse('''<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Acceso MASCLI 2.9</title><style>body{font:16px system-ui;background:#101b32;color:#eef4ff;display:grid;place-items:center;min-height:100vh;margin:0}.panel{width:min(410px,90vw);padding:32px;background:#1b2a46;border-radius:16px}label{display:block;margin:16px 0 6px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;border:1px solid #8290a9}button{margin-top:22px;background:#6de7d4;color:#071e31;border:0;font-weight:700;cursor:pointer}small{color:#c5d3e9}#error{color:#ffaaaa}</style><div class="panel"><h1>MASCLI RC 3.0</h1><p>Acceso al Sistema de Gestión Territorial</p><form id="f"><label>Usuario</label><input name="username" autocomplete="username" required><label>Contraseña</label><input type="password" name="password" autocomplete="current-password" required><label>Código de autenticador (si está activado)</label><input name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button>Ingresar</button></form><p id="error" role="alert"></p><small>Acceso exclusivo para personal autorizado.</small></div><script>document.querySelector('#f').onsubmit=async e=>{e.preventDefault();const d=new FormData(e.target);const r=await fetch('/login',{method:'POST',body:d});if(r.ok)location.href='/';else document.querySelector('#error').textContent='Credenciales inválidas o acceso inhabilitado';};</script></html>''')

@app.post('/login')
def login_action(username:str=Form(...),password:str=Form(...),otp:str=Form('')):
    c=auth_conn()
    row=c.execute('SELECT * FROM auth_users WHERE username=?',(username.strip().lower(),)).fetchone()
    if not row or not row['active'] or not verify_password(password,row['password_hash']):
        c.close(); raise HTTPException(401,'Credenciales inválidas')
    if row['totp_enabled'] and not totp_ok(row['totp_secret'],otp):
        c.close();raise HTTPException(401,'Código de autenticación inválido')
    token=secrets.token_hex(32)
    c.execute('INSERT INTO auth_sessions VALUES(?,?,?,?)',(hashlib.sha256(token.encode()).hexdigest(),row['username'],int(time.time())+SESSION_SECONDS,now()))
    c.commit();c.close()
    response=JSONResponse({'ok':True,'name':row['full_name'],'role':row['role']})
    response.set_cookie(COOKIE_NAME,token,httponly=True,samesite='strict',secure=os.getenv('MASCLI_COOKIE_SECURE','0')=='1',max_age=SESSION_SECONDS,path='/')
    return response

@app.post('/logout')
def logout(request:Request):
    token=request.cookies.get(COOKIE_NAME,'')
    if token:
        c=auth_conn();c.execute('DELETE FROM auth_sessions WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),));c.commit();c.close()
    response=JSONResponse({'ok':True});response.delete_cookie(COOKIE_NAME,path='/');return response

@app.get('/system/auth/me')
def auth_me(request:Request):
    return auth_identity(request)

class AccountIn(BaseModel):
    username:str
    full_name:str
    password:str
    role:str='consulta'

@app.post('/system/auth/accounts')
def add_account(data:AccountIn):
    if not re.fullmatch(r'[a-z0-9_.-]{3,40}',data.username): raise HTTPException(422,'Usuario inválido')
    if data.role not in AUTH_ROLES: raise HTTPException(422,'Rol no válido')
    if len(data.password)<12: raise HTTPException(422,'Contraseña demasiado corta: mínimo 12 caracteres')
    c=auth_conn()
    try:
        c.execute('INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?)',(data.username,data.full_name[:120],hash_password(data.password),data.role,1,now()));c.commit()
    except sqlite3.IntegrityError: raise HTTPException(409,'Usuario existente')
    finally: c.close()
    return {'ok':True,'username':data.username,'role':data.role}

@app.get('/system/auth/accounts')
def list_accounts():
    c=auth_conn(); rows=c.execute('SELECT username,full_name,role,active,created_at FROM auth_users').fetchall();c.close()
    return [dict(r) for r in rows]

@app.get('/select-project',response_class=HTMLResponse)
def select_project_page(request:Request):
    import html
    identity=auth_identity(request)
    if not identity:return RedirectResponse('/login',status_code=303)
    c=auth_conn();items=c.execute('SELECT p.company_id,p.project_id,p.label FROM tenant_projects p JOIN access_grants g ON p.company_id=g.company_id AND p.project_id=g.project_id WHERE g.username=?',(identity['username'],)).fetchall();c.close()
    choices=''.join('<option value="'+html.escape(r['company_id']+'/'+r['project_id'],quote=True)+'">'+html.escape(r['label'])+' ('+html.escape(r['company_id']+'/'+r['project_id'])+')</option>' for r in items)
    return HTMLResponse('<html lang="es"><meta charset="utf-8"><title>Seleccionar proyecto MASCLI</title><body style="font:18px system-ui;max-width:600px;margin:10vh auto"><h1>Selecciona tu proyecto autorizado</h1><form method="post" action="/select-project"><select name="scope" style="padding:12px;width:100%">'+choices+'</select><p><button style="padding:12px">Entrar al proyecto</button></p></form></body></html>')

@app.post('/select-project')
def select_project_action(request:Request,scope:str=Form(...)):
    identity=auth_identity(request)
    if not identity:raise HTTPException(401)
    if request.headers.get('origin'):
        from urllib.parse import urlsplit
        if urlsplit(request.headers['origin']).netloc!=request.headers.get('host'):raise HTTPException(403)
    c=auth_conn();ok=c.execute("SELECT 1 FROM access_grants WHERE username=? AND company_id||'/'||project_id=?",(identity['username'],scope)).fetchone();c.close()
    if not ok:raise HTTPException(403,'Proyecto no autorizado')
    resp=RedirectResponse('/',status_code=303)
    resp.set_cookie('mascli_scope',scope,httponly=True,samesite='strict',secure=os.getenv('MASCLI_COOKIE_SECURE','0')=='1',max_age=SESSION_SECONDS)
    return resp

@app.get('/system/auth/current-scope')
def current_scope():
    company,project=SCOPE_ID.get() or ('MASCLI','PRJ-SECHURA')
    return {'company_id':company,'project_id':project,'scope':company+'/'+project}

@app.get('/system/auth/scopes')
def available_scopes(request:Request):
    user=auth_identity(request)
    if not user:raise HTTPException(401,'Inicie sesión')
    c=auth_conn();rows=c.execute('SELECT p.company_id,p.project_id,p.label FROM tenant_projects p JOIN access_grants g ON g.company_id=p.company_id AND g.project_id=p.project_id WHERE g.username=?',(user['username'],)).fetchall();c.close()
    return [dict(r) for r in rows]

class ScopeCreate(BaseModel):
    company_id:str
    project_id:str
    label:str
    username:str

@app.post('/system/auth/scopes')
def create_scope(item:ScopeCreate,request:Request):
    if not auth_identity(request) or auth_identity(request)['role']!='admin':raise HTTPException(403,'Administrador requerido')
    if not re.fullmatch('[A-Za-z0-9_-]{2,64}',item.company_id) or not re.fullmatch('[A-Za-z0-9_-]{2,64}',item.project_id):raise HTTPException(422,'IDs inválidos')
    target=item.company_id+'/'+item.project_id
    if target=='MASCLI/PRJ-SECHURA':raise HTTPException(409,'Proyecto reservado')
    path=TENANT_DIR/(hashlib.sha256(target.encode()).hexdigest()[:24]+'.db')
    c=auth_conn()
    if not c.execute('SELECT 1 FROM auth_users WHERE username=?',(item.username,)).fetchone():c.close();raise HTTPException(404,'Usuario no existe')
    if c.execute('SELECT 1 FROM tenant_projects WHERE company_id=? AND project_id=?',(item.company_id,item.project_id)).fetchone():c.close();raise HTTPException(409,'Proyecto existente')
    TENANT_DIR.mkdir(parents=True,exist_ok=True)
    # Crea únicamente las tablas operativas vacías (sin datos semilla de Sechura).
    t=sqlite3.connect(path)
    original=sqlite3.connect(DB)
    for (definition,) in original.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"):
        if not definition.lower().startswith('create virtual table'):t.execute(definition)
    t.execute('INSERT OR IGNORE INTO records(module,record_id,payload,created_at,updated_at) VALUES(?,?,?,?,?)',('Proyectos',item.project_id,json.dumps({'Proyecto_ID':item.project_id,'Nombre':item.label,'Estado':'Activo','Territorio':'','Descripcion':''},ensure_ascii=False),now(),now()))
    t.commit();t.close();original.close()
    c.execute('INSERT INTO tenant_projects VALUES(?,?,?)',(item.company_id,item.project_id,item.label[:120]))
    c.execute('INSERT INTO access_grants VALUES(?,?,?)',(item.username,item.company_id,item.project_id))
    c.commit();c.close()
    return {'ok':True,'scope':target}

class GrantIn(BaseModel):
    username:str
    company_id:str
    project_id:str

@app.post('/system/auth/grants')
def grant_scope(item:GrantIn,request:Request):
    if not auth_identity(request) or auth_identity(request)['role']!='admin':raise HTTPException(403)
    c=auth_conn()
    try:
        if not c.execute('SELECT 1 FROM auth_users WHERE username=?',(item.username,)).fetchone():raise HTTPException(404,'Usuario inexistente')
        if not c.execute('SELECT 1 FROM tenant_projects WHERE company_id=? AND project_id=?',(item.company_id,item.project_id)).fetchone():raise HTTPException(404,'Proyecto inexistente')
        c.execute('INSERT OR IGNORE INTO access_grants VALUES(?,?,?)',(item.username,item.company_id,item.project_id));c.commit()
    finally:c.close()
    return {'ok':True}

@app.post('/system/auth/totp/setup')
def totp_setup(request:Request):
    user=auth_identity(request)
    if not user:raise HTTPException(401)
    secret=base64.b32encode(secrets.token_bytes(20)).decode().rstrip('=')
    c=auth_conn()
    try:
        updated=c.execute('UPDATE auth_users SET totp_secret=?,totp_enabled=0 WHERE username=? AND totp_enabled=0',(secret,user['username']))
        if updated.rowcount==0:raise HTTPException(409,'MFA ya está activado; no se permite reiniciar la configuración')
        c.commit()
    finally:c.close()
    from urllib.parse import quote
    uri=f'otpauth://totp/MASCLI:{quote(user["username"])}?secret={secret}&issuer=MASCLI&algorithm=SHA1&digits=6&period=30'
    return {'secret':secret,'otpauth_uri':uri,'instruction':'Añada el código en una aplicación TOTP y confirme con /system/auth/totp/enable.'}

class TOTPVerify(BaseModel):
    code:str

@app.post('/system/auth/totp/enable')
def totp_enable(payload:TOTPVerify,request:Request):
    user=auth_identity(request)
    if not user:raise HTTPException(401)
    c=auth_conn();r=c.execute('SELECT totp_secret FROM auth_users WHERE username=?',(user['username'],)).fetchone()
    if not r or not r['totp_secret'] or not totp_ok(r['totp_secret'],payload.code):c.close();raise HTTPException(422,'Código TOTP incorrecto')
    c.execute('UPDATE auth_users SET totp_enabled=1 WHERE username=?',(user['username'],));c.execute('DELETE FROM auth_sessions WHERE username=? AND token_hash!=?',(user['username'],hashlib.sha256(request.cookies.get(COOKIE_NAME,'').encode()).hexdigest()));c.commit();c.close()
    return {'ok':True,'totp_enabled':True}

@app.on_event("startup")
def startup():
    init_db()
    init_auth_global()


def init_auth_global():
    c=auth_conn()
    c.execute("CREATE TABLE IF NOT EXISTS auth_users (username TEXT PRIMARY KEY, full_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,totp_secret TEXT,totp_enabled INTEGER NOT NULL DEFAULT 0)")
    c.execute("CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY,username TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL)")
    c.execute("CREATE TABLE IF NOT EXISTS tenant_projects (company_id TEXT NOT NULL,project_id TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(company_id,project_id))")
    c.execute("CREATE TABLE IF NOT EXISTS access_grants (username TEXT NOT NULL,company_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(username,company_id,project_id))")
    legacy=conn()
    try:
        rows=legacy.execute("SELECT * FROM auth_users").fetchall()
        for r in rows:c.execute("INSERT OR IGNORE INTO auth_users(username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?)",(r['username'],r['full_name'],r['password_hash'],r['role'],r['active'],r['created_at']))
    except sqlite3.OperationalError:pass
    finally:legacy.close()
    username=os.getenv('MASCLI_ADMIN_USERNAME','admin').strip().lower()
    password=os.getenv('MASCLI_ADMIN_PASSWORD','')
    if not c.execute('SELECT 1 FROM auth_users LIMIT 1').fetchone():
        if len(password)<12: raise RuntimeError('Configure MASCLI_ADMIN_PASSWORD (mínimo 12 caracteres)')
        c.execute('INSERT INTO auth_users(username,full_name,password_hash,role,active,created_at) VALUES(?,?,?,?,?,?)',(username,'Crystell Granda',hash_password(password),'admin',1,now()))
    c.execute("INSERT OR IGNORE INTO tenant_projects VALUES('MASCLI','PRJ-SECHURA','Proyecto Sechura (migración)')")
    for r in c.execute("SELECT username FROM auth_users WHERE role='admin'").fetchall():
        c.execute("INSERT OR IGNORE INTO access_grants VALUES(?,'MASCLI','PRJ-SECHURA')",(r['username'],))
    c.commit();c.close()


DIM_LABELS = {
    "G":"Gobernanza y representación",
    "A":"Actores e influencia",
    "D":"Demandas y compromisos",
    "N":"Narrativas y señales digitales",
    "E":"Ambiental-territorial",
    "I":"Institucional y trazabilidad"
}

def scoped_config(source):
    if SCOPE_DB.get() is None or SCOPE_DB.get()==DB:return source
    folder=TENANT_DIR/(SCOPE_DB.get().stem+'_settings')
    folder.mkdir(parents=True,exist_ok=True)
    dest=folder/source.name
    if not dest.exists():
        import shutil
        shutil.copyfile(source,dest)
    return dest

def load_irsa_config():
    return json.loads(scoped_config(IRSA_CONFIG).read_text(encoding="utf-8"))

def save_irsa_config(cfg):
    scoped_config(IRSA_CONFIG).write_text(json.dumps(cfg,ensure_ascii=False,indent=2),encoding="utf-8")

def dimension_code(value):
    if not value:
        return None
    s=str(value).strip()
    if s and s[0] in "GADNEI":
        return s[0]
    low=s.lower()
    map_words={
        "gobernanza":"G","representación":"G","actores":"A","influencia":"A",
        "demandas":"D","compromisos":"D","narrativas":"N","digitales":"N",
        "ambiental":"E","territorial":"E","institucional":"I","trazabilidad":"I"
    }
    for k,v in map_words.items():
        if k in low:
            return v
    return None

def records_of(module):
    c=conn()
    rows=c.execute("SELECT record_id,payload FROM records WHERE module=?",(module,)).fetchall()
    c.close()
    out=[]
    for r in rows:
        p=json.loads(r["payload"])
        p["_id"]=r["record_id"]
        out.append(p)
    return out

def is_open_state(value):
    s=str(value or "").strip().lower()
    return s not in ("cerrada","cerrado","descartada","descartado","cumplido","cumplida","cancelado","cancelada","atendida")

def compute_irsa():
    cfg=load_irsa_config()
    contrib=cfg["contributions"]
    weights=cfg["weights"]
    scores={d:0.0 for d in DIM_LABELS}
    details={d:[] for d in DIM_LABELS}

    # 1. Active alerts
    for r in records_of("Alertas"):
        d=dimension_code(r.get("Dimension"))
        if d and is_open_state(r.get("Estado")):
            val=contrib["active_alert"]
            scores[d]+=val
            details[d].append({
                "type":"alerta_activa","id":r.get("_id"),
                "label":r.get("Causa") or "Alerta activa",
                "points":val
            })

    # 2. Relevant / critical events
    for r in records_of("Eventos"):
        dims=set(filter(None,[dimension_code(r.get("Dimension_Principal")),dimension_code(r.get("Dimension_Secundaria"))]))
        rel=str(r.get("Relevancia_Preliminar") or "").lower()
        val=0
        if "crít" in rel or "crit" in rel:
            val=contrib["critical_event"]
        elif "alta" in rel:
            val=contrib["high_event"]
        if val:
            for d in dims:
                scores[d]+=val
                details[d].append({
                    "type":"evento_relevante","id":r.get("_id"),
                    "label":r.get("Tipo_Evento") or r.get("Descripcion_Hecho") or "Evento relevante",
                    "points":val
                })

    # 3. Open demands
    for r in records_of("Demandas"):
        d=dimension_code(r.get("Dimension"))
        if d and is_open_state(r.get("Estado")):
            val=contrib["open_demand"]
            scores[d]+=val
            details[d].append({
                "type":"demanda_abierta","id":r.get("_id"),
                "label":r.get("Tema") or r.get("Descripcion") or "Demanda abierta",
                "points":val
            })

    # 4. Pending actions, assigned to the dimension of their linked alert when possible
    alert_dim={}
    for r in records_of("Alertas"):
        alert_dim[str(r.get("ID_Alerta") or r.get("_id"))]=dimension_code(r.get("Dimension"))
    for r in records_of("Acciones"):
        state=str(r.get("Estado") or "").lower()
        if state in ("pendiente","en curso","vencida","vencido"):
            d=alert_dim.get(str(r.get("ID_Alerta") or ""))
            if d:
                val=contrib["pending_action"]
                scores[d]+=val
                details[d].append({
                    "type":"accion_pendiente","id":r.get("_id"),
                    "label":r.get("Accion") or "Acción pendiente",
                    "points":val
                })

    # 5. Unverified narratives
    for r in records_of("Narrativas"):
        d=dimension_code(r.get("Dimension")) or "N"
        ver=str(r.get("Nivel_Verificacion") or "").lower()
        if ("no verificada" in ver) or ver.startswith("e -"):
            val=contrib["unverified_narrative"]
            scores[d]+=val
            details[d].append({
                "type":"narrativa_no_verificada","id":r.get("_id"),
                "label":r.get("Tema") or r.get("Descripcion") or "Narrativa no verificada",
                "points":val
            })

    # Cap to 100 and calculate weighted IRSA
    scores={d:round(min(100.0,v),2) for d,v in scores.items()}
    irsa=round(sum(scores[d]*float(weights.get(d,0)) for d in scores),2)

    thresholds=cfg["thresholds"]
    level="Rojo"
    for name,(lo,hi) in thresholds.items():
        if float(lo) <= irsa <= float(hi):
            level=name
            break

    # Explain top drivers
    drivers=[]
    for d,items in details.items():
        for x in items:
            drivers.append({**x,"dimension":d,"dimension_label":DIM_LABELS[d]})
    drivers=sorted(drivers,key=lambda x:x["points"],reverse=True)[:15]

    return {
        "irsa":irsa,
        "level":level,
        "scores":scores,
        "weights":weights,
        "thresholds":thresholds,
        "drivers":drivers,
        "details":details,
        "config_version":cfg.get("version"),
        "status":cfg.get("status"),
        "notes":cfg.get("notes",[])
    }

@app.get("/health")
def health():
    return {"status":"ok","service":"MASCLI","version":"V0.5.1"}

@app.get("/", response_class=HTMLResponse)
def home():
    return (BASE/"static"/"index.html").read_text(encoding="utf-8")


# Análisis situacional: síntesis determinista de la Base Maestra, no juicio validado.
def build_situational(project_id="PRJ-SECHURA"):
    from collections import Counter
    c=conn()
    groups={}
    for module in ("Eventos","Actores","Demandas","Compromisos","Narrativas","Alertas","Acciones","Fuentes"):
        rows=c.execute("SELECT record_id,payload FROM records WHERE module=? ORDER BY updated_at DESC",(module,)).fetchall()
        items=[]
        for row in rows:
            d=json.loads(row["payload"])
            pid=d.get("Proyecto_ID") or "PRJ-SECHURA"
            if pid==project_id:
                d["_id"]=row["record_id"]
                items.append(d)
        groups[module]=items
    proj=c.execute("SELECT payload FROM records WHERE module='Proyectos'").fetchall()
    project=next((json.loads(x['payload']) for x in proj if json.loads(x['payload']).get('Proyecto_ID')==project_id),{})
    c.close()
    ev=groups['Eventos']; de=groups['Demandas']; al=groups['Alertas']; nar=groups['Narrativas']; ac=groups['Actores']
    closed={'cerrada','cerrado','descartado','descartada','resuelta','resuelto'}
    active_alerts=[x for x in al if str(x.get('Estado','')).strip().lower() not in closed]
    open_demands=[x for x in de if str(x.get('Estado','')).strip().lower() not in closed]
    territories=Counter(str(x.get('Territorio') or 'Sin precisar') for x in ev)
    themes=Counter(str(x.get('Tema') or 'Sin tema') for x in open_demands)
    levels=Counter(str(x.get('Nivel_Preliminar') or x.get('Nivel') or 'Sin nivel') for x in active_alerts)
    def trim(items,fields,limit=8):
        return [{k:x.get(k,'') for k in fields}|{'id':x['_id']} for x in items[:limit]]
    observations=[]
    if active_alerts: observations.append(f"Constan {len(active_alerts)} alertas con estado no cerrado; requieren verificación de vigencia, gravedad y responsable.")
    if open_demands: observations.append(f"Se registran {len(open_demands)} demandas no cerradas; revisar competencia y respuesta institucional.")
    if nar: observations.append(f"Existen {len(nar)} narrativas registradas; su contenido no constituye por sí mismo prueba de un hecho.")
    if not observations: observations.append('No hay señales suficientes para emitir conclusiones sustantivas con esta base de datos.')
    recommendations=[]
    if active_alerts: recommendations.append('Revisar alertas abiertas, contrastar evidencias y asignar responsables y plazos.')
    if open_demands: recommendations.append('Actualizar la trazabilidad de demandas, respuesta institucional y compromisos asociados.')
    if nar: recommendations.append('Contrastar narrativas con fuentes independientes antes de atribuir hechos o responsabilidades.')
    recommendations.extend(['Validar el diagnóstico con el equipo territorial y registrar fecha, fuentes y analista responsable.', 'Aplicar seguimiento periódico y documentar cambios frente al corte anterior.'])
    scenarios=[{'nombre':'Favorable','supuesto':'Se atienden y verifican oportunamente las demandas y alertas pendientes.'},{'nombre':'Intermedio','supuesto':'Persisten demandas y señales sin escalamiento confirmado.'},{'nombre':'Crítico','supuesto':'Convergen eventos corroborados, alertas graves y falta de respuesta oportuna.'}]
    return {'project_id':project_id,'project_name':project.get('Nombre','Proyecto Sechura' if project_id=='PRJ-SECHURA' else project_id),
     'generated_at':now(),'method':'Síntesis descriptiva basada en registros; no predicción ni evaluación pericial.',
     'counts':{k.lower():len(v) for k,v in groups.items()},'alertas_activas':len(active_alerts),'demandas_pendientes':len(open_demands),
     'territorios':territories.most_common(8),'temas_demanda':themes.most_common(8),'niveles_alerta':levels.most_common(),
     'eventos_recientes':trim(ev,['Fecha','Territorio','Descripcion_Hecho','Nivel_Verificacion','Fuente_ID']),
     'alertas_prioritarias':trim(sorted(active_alerts,key=lambda x: {'rojo':0,'naranja':1,'amarillo':2,'verde':3}.get(str(x.get('Nivel_Preliminar','')).lower(),4)),['Fecha','Nivel_Preliminar','Causa','Accion_Sugerida','Fuente_ID']),
     'demandas_abiertas':trim(open_demands,['Fecha_Registro','Tema','Descripcion','Estado','Fuente_ID']),
     'actores':trim(ac,['Nombre_Actor/Organizacion','Posicion_Proyecto','Influencia','Fuente_Principal']),
     'observaciones':observations,'escenarios':scenarios,'recomendaciones':recommendations,
     'limitations':['Los registros pueden estar desactualizados, incompletos o pendientes de verificación.','Los escenarios son condicionales, no pronósticos.','IRSA requiere validación de pesos y umbrales; no se interpreta aquí como medición científica definitiva.','El reporte requiere revisión y aprobación de un analista antes de circularse como documento institucional.']}

@app.get('/system/situational-analysis')
def situational_analysis(project_id:str='PRJ-SECHURA'):
    return build_situational(project_id)

@app.get('/system/situational-report.docx')
def situational_report_docx(project_id:str='PRJ-SECHURA'):
    from docx import Document
    from io import BytesIO
    data=build_situational(project_id)
    doc=Document()
    doc.add_heading('INFORME DE ANÁLISIS SITUACIONAL',0)
    doc.add_paragraph(data['project_name']+' | Corte: '+data['generated_at'])
    doc.add_paragraph('Documento generado automáticamente por MASCLI. BORRADOR SUJETO A REVISIÓN Y VALIDACIÓN HUMANA.')
    doc.add_heading('1. Resumen ejecutivo',1)
    doc.add_paragraph(f"Se integraron {data['counts']['eventos']} eventos, {data['counts']['actores']} actores, {data['demandas_pendientes']} demandas pendientes y {data['alertas_activas']} alertas activas en la Base Maestra del proyecto. Las cifras indican registros, no hechos necesariamente corroborados.")
    doc.add_heading('2. Diagnóstico de la situación',1)
    for t in data['observaciones']: doc.add_paragraph(t,style='List Bullet')
    doc.add_heading('3. Territorios con eventos registrados',1)
    for n,v in data['territorios']: doc.add_paragraph(f'{n}: {v} registros',style='List Bullet')
    doc.add_heading('4. Demandas y asuntos relevantes',1)
    for x in data['demandas_abiertas']: doc.add_paragraph(f"[{x['id']}] {x.get('Tema','')} — {x.get('Descripcion','')} (Fuente: {x.get('Fuente_ID') or 'no consignada'})",style='List Bullet')
    doc.add_heading('5. Alertas prioritarias',1)
    for x in data['alertas_prioritarias']: doc.add_paragraph(f"[{x['id']}] {x.get('Nivel_Preliminar','Sin nivel')}: {x.get('Causa','')} (Fuente: {x.get('Fuente_ID') or 'no consignada'})",style='List Bullet')
    doc.add_heading('6. Escenarios condicionales',1)
    for x in data['escenarios']: doc.add_paragraph(f"{x['nombre']}: {x['supuesto']}",style='List Bullet')
    doc.add_heading('7. Recomendaciones',1)
    for x in data['recomendaciones']: doc.add_paragraph(x,style='List Bullet')
    doc.add_heading('8. Alcances y limitaciones',1)
    for x in data['limitations']: doc.add_paragraph(x,style='List Bullet')
    doc.add_paragraph('Preparado por: Sistema MASCLI | Revisión técnica: __________________ | Fecha de validación: ______________')
    output=BytesIO();doc.save(output);output.seek(0)
    return StreamingResponse(output,media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',headers={'Content-Disposition':'attachment; filename="MASCLI_Analisis_Situacional.docx"'})


# RC 1.7: segunda capa MASCLI. No altera el cálculo del IRSA ni sus umbrales.
EXTENDED_MODULES = {
    'intereses':'Intereses', 'dialogos':'Dialogos', 'oportunidades':'Oportunidades',
    'hechos':'Hechos_Compartidos', 'aarc':'Evaluaciones_AARC'
}

def extended_records(project_id='PRJ-SECHURA'):
    c=conn(); result={}
    for slug,module in EXTENDED_MODULES.items():
        rows=c.execute('SELECT record_id,payload FROM records WHERE module=? ORDER BY updated_at DESC',(module,)).fetchall()
        result[slug]=[dict(json.loads(row['payload']), _id=row['record_id']) for row in rows if json.loads(row['payload']).get('Proyecto_ID','PRJ-SECHURA')==project_id]
    c.close();return result

@app.get('/system/strategic-assessment')
def strategic_assessment(project_id:str='PRJ-SECHURA'):
    r=extended_records(project_id)
    states=lambda items,word:sum(1 for x in items if str(x.get('Estado','')).lower()==word)
    pending=[x for x in r['hechos'] if str(x.get('Estado','')).lower() not in ('validado','cerrado','descartado')]
    opportunities=[x for x in r['oportunidades'] if str(x.get('Estado','')).lower() not in ('descartada','descartado','cerrada','cerrado')]
    dialogues=[x for x in r['dialogos'] if str(x.get('Estado','')).lower() not in ('cerrado','cerrada','finalizado')]
    completed=[x for x in r['aarc'] if all(str(x.get(k,'')).strip() for k in ('Reconocimiento','Agencia','Reciprocidad','Claridad'))]
    return {
      'project_id':project_id, 'generated_at':now(),
      'counts':{k:len(v) for k,v in r.items()},
      'facts_pending':len(pending),'opportunities_open':len(opportunities),'dialogues_open':len(dialogues),
      'aarc_complete':len(completed),
      'attention':(['Existen hechos o datos pendientes de contraste documental y validación conjunta.'] if pending else [])+
                  (['Existen procesos de diálogo registrados que requieren seguimiento.'] if dialogues else [])+
                  (['Existen oportunidades registradas cuya viabilidad y responsables deben revisarse.'] if opportunities else []),
      'limitations':['Métricas descriptivas sobre registros: no representan un índice de consenso ni una estimación predictiva.',
                     'Las calificaciones AARC, cuando existan, son observaciones cualitativas; no se incorporan al IRSA.',
                     'Registrar fuentes, fecha y validación humana antes de tomar decisiones o comunicar resultados.']
    }

# RC 1.8 — motor determinista de recomendaciones trazables, sin IA externa.
# Las recomendaciones son borradores, nunca acuerdos, diagnósticos ni hechos validados.
def automated_consensus(project_id='PRJ-SECHURA'):
    r=extended_records(project_id)
    cards=[]
    def add(kind,title,reason,action,source,related=None,priority='Media'):
        signature=(kind,source,title)
        if any(c['_key']==signature for c in cards):return
        cards.append({'_key':signature,'tipo':kind,'titulo':title,'motivo':reason,'accion_sugerida':action,
          'origen':source,'registros_relacionados':related or [],'prioridad_orientativa':priority,
          'estado':'Propuesta automática; pendiente de revisión humana','autorizacion':'No constituye acuerdo ni compromiso'})
    for x in r['hechos']:
        state=str(x.get('Estado','')).lower().strip()
        if state not in ('validado','cerrado','descartado'):
            add('Hechos compartidos','Preparar verificación conjunta de información',
                'El asunto consta como no validado; no se debe resolver una controversia a partir de una sola versión.',
                'Acordar preguntas, fuentes, metodología, responsables y criterios de validación con los actores participantes.',
                'hechos/'+x['_id'],[x['_id']],'Alta')
        if not str(x.get('Fuente_ID','')).strip():
            add('Calidad de evidencia','Completar fuentes de la controversia',
                'El registro no tiene Fuente_ID.','Vincular al menos una evidencia rastreable antes de emitir conclusiones.',
                'hechos/'+x['_id'],[x['_id']],'Alta')
    for x in r['intereses']:
        ident=x['_id']; actor=str(x.get('Actor','')).strip()
        if not str(x.get('Interes','')).strip():
            add('Negociación por intereses','Explorar intereses expresados, sin inferirlos',
                f'El actor {actor or ident} tiene una ficha sin interés documentado.',
                'Programar escucha consultiva y registrar los intereses declarados con evidencia y consentimiento.',
                'intereses/'+ident,[ident])
        if not str(x.get('Mandato','')).strip():
            add('Representatividad','Verificar mandato antes de acuerdos formales',
                f'La ficha de {actor or ident} no registra sustento documental de mandato.',
                'Solicitar documentación de representación y registrar su vigencia; no asumir falta de legitimidad.',
                'intereses/'+ident,[ident],'Alta')
        if str(x.get('Preocupacion','')).strip() and not str(x.get('Fuente_ID','')).strip():
            add('Información compartida','Documentar origen de preocupación',
                'Se registró una preocupación sin fuente trazable.',
                'Documentar declaración original, fecha, contexto y autorización de uso.',
                'intereses/'+ident,[ident])
    for x in r['dialogos']:
        ident=x['_id'];state=str(x.get('Estado','')).lower()
        if state not in ('cerrado','cerrada','finalizado'):
            if not str(x.get('Proximo_Paso','')).strip() or not str(x.get('Responsable','')).strip():
                add('Arquitectura de consenso','Definir seguimiento del diálogo',
                    'El proceso abierto no tiene responsable o siguiente paso completo.',
                    'Acordar responsable, plazo, mecanismo de rendición de cuentas y forma de gestionar desacuerdos.',
                    'dialogos/'+ident,[ident],'Alta')
            if not str(x.get('Fuente_ID','')).strip():
                add('Trazabilidad','Vincular acta o evidencia del proceso',
                    'El proceso de diálogo no presenta una fuente identificada.',
                    'Adjuntar acta, registro consentido o evidencia verificable.',
                    'dialogos/'+ident,[ident])
    for x in r['oportunidades']:
        ident=x['_id']; state=str(x.get('Estado','')).lower()
        if state not in ('cerrado','cerrada','descartada','descartado'):
            if not str(x.get('Viabilidad','')).strip() or not str(x.get('Restricciones','')).strip():
                add('Mutual Gains / valor compartido','Examinar viabilidad de oportunidad',
                    'La oportunidad registrada necesita evaluación técnica, legal o presupuestal.',
                    'Contrastar beneficios para cada actor, restricciones, financiamiento y opciones alternativas; no presentarla como promesa.',
                    'oportunidades/'+ident,[ident])
            if not str(x.get('Responsable','')).strip():
                add('Gobernanza adaptativa','Asignar responsable de evaluación',
                    'La oportunidad abierta no tiene un responsable de seguimiento documentado.',
                    'Definir responsable de evaluar, sin convertir una propuesta en compromiso.',
                    'oportunidades/'+ident,[ident])
    for x in r['aarc']:
        ident=x['_id']
        missing=[label for key,label in [('Reconocimiento','reconocimiento'),('Agencia','agencia'),('Reciprocidad','reciprocidad'),('Claridad','claridad')] if not str(x.get(key,'')).strip()]
        if missing:
            add('AARC / relacionamiento','Completar evaluación cualitativa AARC',
                'Dimensiones sin documentación: '+', '.join(missing)+'.',
                'Recoger observaciones verificables con participación de los involucrados; evitar una puntuación ficticia.',
                'aarc/'+ident,[ident])
        elif not str(x.get('Evidencia','')).strip():
            add('AARC / evidencia','Sustentar evaluación AARC',
                'La evaluación registra las cuatro dimensiones sin evidencia indicada.',
                'Vincular hechos observables, fuentes y fecha de evaluación.',
                'aarc/'+ident,[ident])
    # Recomendación intermodular: surge únicamente de registros comprobables de la misma aplicación.
    if r['intereses'] and r['oportunidades']:
        add('Integración intereses-valor','Contrastar intereses con cartera de oportunidades',
            'Existen fichas de intereses y oportunidades para el mismo proyecto; no se presume coincidencia ni apoyo.',
            'Revisar conjuntamente la correspondencia y documentar coincidencias, desacuerdos y restricciones antes de generar opciones.',
            'intereses+oportunidades',[x['_id'] for x in r['intereses'][:3]]+[x['_id'] for x in r['oportunidades'][:3]])
    if r['hechos'] and r['dialogos']:
        add('Integración hechos-diálogo','Incluir controversias verificables en la agenda de diálogo',
            'El proyecto registra tanto procesos de diálogo como asuntos sujetos a verificación.',
            'Preguntar a los participantes qué hechos necesitan verificar juntos y acordar un procedimiento transparente.',
            'hechos+dialogos',[r['hechos'][0]['_id'],r['dialogos'][0]['_id']])
    counts={k:len(v) for k,v in r.items()}
    return {'project_id':project_id,'generated_at':now(),'method':'reglas trazables v1.8 (sin inferencia predictiva ni IA generativa)',
            'counts':counts,'recommendations':[{k:v for k,v in card.items() if k!='_key'} for card in cards],
            'summary':{'total':len(cards),'alta':sum(c['prioridad_orientativa']=='Alta' for c in cards)},
            'limitations':['Los disparadores indican faltantes de registros, no defectos reales de personas ni instituciones.',
              'El módulo no modifica IRSA, no aprueba acuerdos, no compromete presupuesto y no produce diagnósticos de legitimidad.',
              'Los registros deben tener fuentes, controles de acceso y revisión profesional antes del uso institucional.']}

# RC 1.9: cruces reproducibles, con vínculos explícitos y coincidencia temática orientativa.
# Un vínculo nunca implica consentimiento, representación ni aprobación.
STOPWORDS = set('para como entre desde sobre este esta estos estas donde cuando porque alguno alguna unas unos los las del por con que una uno algo ante bajo frente proyecto actor actores local locales comunidad comunidades territorio registro propuesta proceso potencial posible sus suyo caso debe estar parte mediante'.split())

def thematic_terms(value):
    t=unicodedata.normalize('NFKD', str(value or '').lower())
    t=''.join(c for c in t if not unicodedata.combining(c))
    return {x for x in re.findall(r'[a-z]{4,}',t) if x not in STOPWORDS}

def record_links(a,b):
    for field in ('ID_Actor','ID_Demanda','ID_Proceso','Tema_ID','Vinculo_ID'):
        left=str(a.get(field,'')).strip();right=str(b.get(field,'')).strip()
        if left and right and left.casefold()==right.casefold():return ('referencia explícita', [field])
    for field in ('Registros_Relacionados','Referencias_ID'):
        left={t.strip() for t in str(a.get(field,'')).split(',') if t.strip()}
        right={t.strip() for t in str(b.get(field,'')).split(',') if t.strip()}
        if a.get('_id') in right or b.get('_id') in left or bool(left&right):return ('referencia cruzada', [])
    return None

def candidate_pairs(project_id='PRJ-SECHURA'):
    r=extended_records(project_id)
    specs=[('intereses','oportunidades',('Interes','Preocupacion'),('Oportunidad','Tipo','Beneficiarios')),
           ('hechos','dialogos',('Asunto','Preguntas'),('Tema','Proceso')),
           ('intereses','dialogos',('Posicion','Interes','Preocupacion'),('Tema','Proceso')),
           ('hechos','oportunidades',('Asunto','Preguntas'),('Oportunidad','Restricciones'))]
    out=[]
    for mod_a,mod_b,fields_a,fields_b in specs:
        for x in r[mod_a][:150]:
            for y in r[mod_b][:150]:
                link=record_links(x,y)
                left=thematic_terms(' '.join(str(x.get(k,'') or '') for k in fields_a))
                right=thematic_terms(' '.join(str(y.get(k,'') or '') for k in fields_b))
                shared=sorted(left&right)
                if not link and len(shared)<2:continue
                rule=link[0] if link else 'coincidencia léxica (no implica relación probada)'
                out.append({'origen':mod_a+'/'+x['_id'],'destino':mod_b+'/'+y['_id'],
                  'criterio':rule,'terminos_compartidos':shared[:8],
                  'estado':'Hipótesis de vínculo; verificar con fuentes y participantes',
                  'uso_sugerido':'Revisar pertinencia del vínculo, intereses expresados y posibles restricciones antes de diseñar opciones'})
    return out[:120]

@app.get('/system/integrated-analysis')
def integrated_analysis(project_id:str='PRJ-SECHURA'):
    r=extended_records(project_id)
    pairs=candidate_pairs(project_id)
    recommendations=automated_consensus(project_id)['recommendations']
    actions=[]
    for i,c in enumerate(recommendations,1):
        actions.append({'numero':i,'accion':c['accion_sugerida'],'objetivo':c['titulo'],
          'fundamento':c['motivo'],'registros':c['registros_relacionados'],
          'prioridad_orientativa':c['prioridad_orientativa'],
          'responsable':'Por asignar tras revisión','plazo':'Por acordar',
          'estado':'Borrador automático — no aprobado'})
    return {'project_id':project_id,'generated_at':now(),'version':'1.9',
      'summary':{'cruces_candidatos':len(pairs),'acciones_sugeridas':len(actions),
                 'registros_estrategicos':sum(len(v) for v in r.values())},
      'candidate_links':pairs,'action_plan':actions,
      'scenarios':[
          {'tipo':'Escenario de mejora','supuesto':'Los actores revisan discrepancias, se verifican fuentes y se acuerdan pasos con responsables.','indicadores_a_observar':['Hechos contrastados','Cumplimiento de compromisos','Participación efectiva']},
          {'tipo':'Escenario de continuidad','supuesto':'Permanecen asuntos abiertos y no se actualizan datos ni acuerdos.','indicadores_a_observar':['Antigüedad de temas abiertos','Calidad de evidencia','Siguientes pasos vencidos']},
          {'tipo':'Escenario de deterioro','supuesto':'Persisten discrepancias y se acumulan compromisos incumplidos corroborados.','indicadores_a_observar':['Alertas comprobadas','Demandas pendientes','Cambios documentados en el relacionamiento']}],
      'limitations':['Las asociaciones textuales son candidatas, no relaciones verificadas. No se hacen inferencias personales sobre los actores.',
        'Los escenarios son condicionales, no pronósticos ni probabilidades. No se modifica el IRSA.',
        'No se crea ningún compromiso, se asignan presupuestos ni se califica legitimidad sin revisión humana.',
        'Los resultados proceden solo de registros del proyecto y requieren auditoría de fuentes y control de acceso.']}

@app.get('/system/integrated-analysis.docx')
def integrated_analysis_docx(project_id:str='PRJ-SECHURA'):
    from docx import Document
    from io import BytesIO
    d=integrated_analysis(project_id)
    doc=Document();doc.add_heading('MASCLI | Análisis integrado RC 1.9',0)
    doc.add_paragraph(f"Proyecto {project_id} · Corte {d['generated_at']}")
    doc.add_paragraph('DOCUMENTO AUTOMÁTICO EN BORRADOR. Los vínculos no están confirmados; requiere revisión profesional y contrastación de fuentes.')
    doc.add_heading('1. Cruces candidatos entre módulos',1)
    if not d['candidate_links']:doc.add_paragraph('Sin coincidencias verificables suficientes en los registros disponibles.')
    for x in d['candidate_links']:
        doc.add_paragraph(f"{x['origen']} ↔ {x['destino']} | {x['criterio']} | términos: {', '.join(x['terminos_compartidos'])}",style='List Bullet')
    doc.add_heading('2. Plan de acción propuesto',1)
    if not d['action_plan']:doc.add_paragraph('Sin acciones generadas; la ausencia de registros no demuestra ausencia de riesgo.')
    for x in d['action_plan']:
        doc.add_heading(f"{x['numero']}. {x['objetivo']}",2)
        doc.add_paragraph(f"Acción: {x['accion']}\nFundamento: {x['fundamento']}\nRegistros: {', '.join(x['registros'])}\nResponsable: por asignar | Estado: no aprobado")
    doc.add_heading('3. Escenarios condicionales (no predicciones)',1)
    for x in d['scenarios']:
        doc.add_heading(x['tipo'],2);doc.add_paragraph(x['supuesto']);doc.add_paragraph('Indicadores: '+', '.join(x['indicadores_a_observar']))
    doc.add_heading('4. Alcances y salvaguardas',1)
    for x in d['limitations']:doc.add_paragraph(x,style='List Bullet')
    doc.add_paragraph('Revisado por: __________________  Fecha: _________________')
    buf=BytesIO();doc.save(buf);buf.seek(0)
    return StreamingResponse(buf,media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',headers={'Content-Disposition':'attachment; filename="MASCLI_RC19_Analisis_Integrado.docx"'})

@app.get('/system/consensus-engine')
def consensus_engine(project_id:str='PRJ-SECHURA'):
    return automated_consensus(project_id)

@app.get('/system/consensus-engine.docx')
def consensus_engine_docx(project_id:str='PRJ-SECHURA'):
    from docx import Document
    from io import BytesIO
    report=automated_consensus(project_id)
    doc=Document();doc.add_heading('MASCLI | Motor de valor y consenso',0)
    doc.add_paragraph(f"Proyecto: {project_id} · Corte: {report['generated_at']}")
    doc.add_paragraph('BORRADOR AUTOMATIZADO: recomendaciones basadas en registros y reglas. REVISIÓN HUMANA OBLIGATORIA.')
    for i,x in enumerate(report['recommendations'],1):
        doc.add_heading(f"{i}. {x['titulo']}",2)
        for name,key in [('Enfoque','tipo'),('Hallazgo de registro','motivo'),('Acción sugerida','accion_sugerida'),('Procedencia','origen'),('Nivel orientativo','prioridad_orientativa')]:
            doc.add_paragraph(f'{name}: {x[key]}')
    doc.add_heading('Limitaciones',1)
    for text in report['limitations']:doc.add_paragraph(text,style='List Bullet')
    doc.add_paragraph('Modelo original: Dick Castillo Inca y Crystell Lizett Granda Agurto. Iniciativa de automatización: Crystell Lizett Granda Agurto.')
    doc.add_paragraph('Revisó: ______________________ Fecha: __________')
    b=BytesIO();doc.save(b);b.seek(0)
    return StreamingResponse(b,media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',headers={'Content-Disposition':'attachment; filename="MASCLI_Motor_Valor_Consenso.docx"'})

@app.get('/system/strategic-report.docx')
def strategic_report_docx(project_id:str='PRJ-SECHURA'):
    from docx import Document
    from io import BytesIO
    r=extended_records(project_id); report=strategic_assessment(project_id)
    situ=build_situational(project_id)
    doc=Document();doc.add_heading('MASCLI | Informe estratégico territorial',0)
    doc.add_paragraph(f"{situ['project_name']} | Corte: {report['generated_at']}")
    doc.add_paragraph('BORRADOR AUTOMATIZADO — REQUIERE REVISIÓN Y APROBACIÓN HUMANA. No sustituye decisiones institucionales.')
    doc.add_heading('1. Situación social documentada',1)
    for item in situ['observaciones']:doc.add_paragraph(item,style='List Bullet')
    sections=[('2. Mapeo de intereses','intereses',['Actor','Posicion','Interes','Preocupacion','Fuente_ID']),
              ('3. Procesos de diálogo y acuerdos','dialogos',['Proceso','Participantes','Tema','Estado','Proximo_Paso']),
              ('4. Valor compartido','oportunidades',['Oportunidad','Beneficiarios','Viabilidad','Estado','Responsable']),
              ('5. Hechos compartidos y controversias','hechos',['Asunto','Estado','Versiones','Fuente_ID','Accion_Verificacion']),
              ('6. Evaluaciones AARC','aarc',['Actor_Proceso','Reconocimiento','Agencia','Reciprocidad','Claridad','Evidencia'])]
    for title,slug,fields in sections:
        doc.add_heading(title,1)
        if not r[slug]:doc.add_paragraph('Sin registros. No es posible emitir conclusiones sobre este componente.')
        for record in r[slug][:40]:
            doc.add_paragraph(f"[{record['_id']}] "+' | '.join(f'{key}: {record[key]}' for key in fields if record.get(key)),style='List Bullet')
    doc.add_heading('7. Alertas metodológicas',1)
    for item in report['limitations']:doc.add_paragraph(item,style='List Bullet')
    doc.add_paragraph('Documento base: Modelo MASCLI, Dick Castillo Inca y Crystell Lizett Granda Agurto (2026).')
    doc.add_paragraph('Concepto de automatización y desarrollo de tesis: Crystell Lizett Granda Agurto.')
    doc.add_paragraph('Validado por: _________________________    Fecha: __________________')
    out=BytesIO();doc.save(out);out.seek(0)
    return StreamingResponse(out,media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',headers={'Content-Disposition':'attachment; filename="MASCLI_Informe_Estrategico.docx"'})

@app.get("/api/dashboard")
def dashboard():
    c=conn()
    def n(module):
        return c.execute("SELECT COUNT(*) n FROM records WHERE module=?",(module,)).fetchone()["n"]
    alerts=[json.loads(r["payload"]) for r in c.execute("SELECT payload FROM records WHERE module='Alertas'")]
    demand=[json.loads(r["payload"]) for r in c.execute("SELECT payload FROM records WHERE module='Demandas'")]
    active_alerts=sum(1 for x in alerts if str(x.get("Estado","")).lower() not in ("cerrada","descartada"))
    open_dem=sum(1 for x in demand if str(x.get("Estado","")).lower()!="cerrada")
    levels={}
    for x in alerts:
        lv=str(x.get("Nivel_Preliminar") or x.get("Nivel") or "Sin nivel")
        levels[lv]=levels.get(lv,0)+1
    c.close()
    return {
        "eventos":n2("Eventos"),"actores":n2("Actores"),"demandas_abiertas":open_dem,
        "alertas_activas":active_alerts,"directorio":n2("Directorio_Territorial"),
        "priorizados":n2("Actores_Priorizados"),"niveles":levels
    }

def n2(module):
    c=conn()
    x=c.execute("SELECT COUNT(*) n FROM records WHERE module=?",(module,)).fetchone()["n"]
    c.close()
    return x


@app.get("/system/irsa")
def irsa_current():
    return compute_irsa()

@app.get("/system/irsa/config")
def irsa_config_get():
    return load_irsa_config()

@app.post("/system/irsa/config")
def irsa_config_update(rec:RecordIn):
    cfg=load_irsa_config()
    patch=rec.payload
    if "weights" in patch:
        w=patch["weights"]
        total=sum(float(w.get(d,0)) for d in DIM_LABELS)
        if abs(total-1.0) > 0.02:
            raise HTTPException(400,"Los pesos deben sumar aproximadamente 1.")
        cfg["weights"]={d:float(w.get(d,0)) for d in DIM_LABELS}
    if "thresholds" in patch:
        cfg["thresholds"]=patch["thresholds"]
    if "contributions" in patch:
        cfg["contributions"].update(patch["contributions"])
    save_irsa_config(cfg)
    c=conn()
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",
              (now(),"IRSA",None,"CONFIG_UPDATE","Parámetros IRSA actualizados"))
    c.commit(); c.close()
    return {"ok":True,"config":cfg}

@app.post("/system/irsa/snapshot")
def irsa_snapshot(rec:RecordIn):
    result=compute_irsa()
    note=str(rec.payload.get("note") or "")
    c=conn()
    c.execute("INSERT INTO irsa_snapshots(ts,irsa,level,scores,config_version,note) VALUES(?,?,?,?,?,?)",
              (now(),result["irsa"],result["level"],json.dumps(result["scores"]),result["config_version"],note))
    sid=c.execute("SELECT last_insert_rowid() id").fetchone()["id"]
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",
              (now(),"IRSA",str(sid),"SNAPSHOT",f"Corte IRSA guardado: {result['irsa']} {result['level']}"))
    c.commit(); c.close()
    return {"ok":True,"id":sid,**result}

@app.get("/system/irsa/history")
def irsa_history(limit:int=50):
    c=conn()
    rows=c.execute("SELECT * FROM irsa_snapshots ORDER BY id DESC LIMIT ?",(limit,)).fetchall()
    c.close()
    out=[]
    for r in rows:
        x=dict(r); x["scores"]=json.loads(x["scores"]); out.append(x)
    return out

def _safe_upload_name(name: str) -> str:
    raw=Path(name or "archivo").name
    stem=unicodedata.normalize("NFKD",Path(raw).stem).encode("ascii","ignore").decode("ascii")
    stem=re.sub(r"[^A-Za-z0-9._-]+","-",stem).strip("-._")[:80] or "archivo"
    return stem + Path(raw).suffix.lower()

def _attachment_dict(row):
    item=dict(row)
    item["Proyecto_ID"]=item.get("project_id") or "PRJ-SECHURA"
    item["Proyecto"]=item.get("project_name") or ("Proyecto Sechura" if item["Proyecto_ID"]=="PRJ-SECHURA" else "")
    item["download_url"]=f"/system/uploads/{item['id']}/download"
    return item

@app.post("/system/uploads")
async def upload_evidence(
    file: UploadFile = File(...),
    linked_module: str = Form(...),
    linked_record_id: str = Form(...),
    document_type: str = Form("Reporte / evidencia"),
    author: str = Form(""),
    verification: str = Form("E - No verificada"),
    notes: str = Form("")
):
    module_key=linked_module.strip().lower()
    if module_key not in MODULES:
        raise HTTPException(400,"Módulo de vínculo no válido")
    safe_name=_safe_upload_name(file.filename or "archivo")
    extension=Path(safe_name).suffix.lower()
    if extension not in ALLOWED_UPLOAD_EXTENSIONS:
        raise HTTPException(415,"Tipo de archivo no permitido. Use PDF, Office, CSV, TXT o imágenes JPG/PNG/WEBP.")
    content=await file.read(MAX_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(400,"El archivo está vacío")
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(413,f"El archivo supera el límite de {MAX_UPLOAD_BYTES // (1024*1024)} MB")
    c=conn()
    target=c.execute("SELECT payload FROM records WHERE module=? AND record_id=?",(MODULES[module_key],linked_record_id)).fetchone()
    if not target:
        c.close(); raise HTTPException(404,"No existe el registro al que se desea vincular el archivo")
    upload_root().mkdir(parents=True,exist_ok=True)
    attachment_id=f"ADJ-{uuid.uuid4().hex[:12].upper()}"
    stored_name=f"{uuid.uuid4().hex}_{safe_name}"
    destination=upload_root()/stored_name
    destination.write_bytes(content)
    detected=mimetypes.guess_type(safe_name)[0] or file.content_type or "application/octet-stream"
    created=now()
    payload=json.loads(target["payload"])
    project_id=str(payload.get("Proyecto_ID") or "PRJ-SECHURA")
    project_name=str(payload.get("Proyecto") or ("Proyecto Sechura" if project_id=="PRJ-SECHURA" else ""))
    c.execute("""INSERT INTO attachments(id,stored_name,original_name,content_type,size_bytes,sha256,linked_module,linked_record_id,document_type,author,verification,notes,project_id,project_name,created_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (attachment_id,stored_name,safe_name,detected,len(content),hashlib.sha256(content).hexdigest(),module_key,linked_record_id,document_type[:120],author[:160],verification[:80],notes[:1000],project_id,project_name,created))
    attachments=payload.get("Adjuntos",[])
    if not isinstance(attachments,list): attachments=[]
    attachments.append({"id":attachment_id,"archivo":safe_name,"tipo":document_type,"verificacion":verification})
    payload["Adjuntos"]=attachments
    if module_key=="eventos": payload["Evidencia/Resultado"]=safe_name
    if module_key=="fuentes": payload["Archivo_Fuente"]=safe_name
    c.execute("UPDATE records SET payload=?,updated_at=? WHERE module=? AND record_id=?",(json.dumps(payload,ensure_ascii=False),created,MODULES[module_key],linked_record_id))
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",(created,MODULES[module_key],linked_record_id,"UPLOAD",f"Evidencia adjunta: {safe_name} ({len(content)} bytes)"))
    c.commit(); c.close()
    return {"ok":True,"attachment":{"id":attachment_id,"original_name":safe_name,"content_type":detected,"size_bytes":len(content),"linked_module":module_key,"linked_record_id":linked_record_id,"document_type":document_type,"author":author,"verification":verification,"notes":notes,"project_id":project_id,"project_name":project_name,"Proyecto_ID":project_id,"Proyecto":project_name,"created_at":created,"download_url":f"/system/uploads/{attachment_id}/download"}}

@app.get("/system/uploads")
def list_uploads(linked_module:Optional[str]=None, linked_record_id:Optional[str]=None, q:Optional[str]=None, limit:int=200):
    clauses=[]; values=[]
    if linked_module:
        clauses.append("linked_module=?"); values.append(linked_module.strip().lower())
    if linked_record_id:
        clauses.append("linked_record_id=?"); values.append(linked_record_id)
    if q:
        clauses.append("(original_name LIKE ? OR document_type LIKE ? OR author LIKE ? OR notes LIKE ?)")
        values.extend([f"%{q}%"]*4)
    where=(" WHERE "+" AND ".join(clauses)) if clauses else ""
    values.append(max(1,min(limit,500)))
    c=conn(); rows=c.execute("SELECT * FROM attachments"+where+" ORDER BY created_at DESC LIMIT ?",values).fetchall(); c.close()
    return [_attachment_dict(r) for r in rows]

@app.get("/system/uploads/{attachment_id}")
def get_upload(attachment_id:str):
    c=conn(); row=c.execute("SELECT * FROM attachments WHERE id=?",(attachment_id,)).fetchone(); c.close()
    if not row: raise HTTPException(404,"Archivo no encontrado")
    return _attachment_dict(row)

@app.get("/system/uploads/{attachment_id}/download")
def download_upload(attachment_id:str):
    c=conn(); row=c.execute("SELECT * FROM attachments WHERE id=?",(attachment_id,)).fetchone(); c.close()
    if not row: raise HTTPException(404,"Archivo no encontrado")
    path=upload_root()/row["stored_name"]
    if not path.is_file(): raise HTTPException(410,"El archivo ya no está disponible en este almacenamiento")
    return FileResponse(path,media_type=row["content_type"] or "application/octet-stream",filename=row["original_name"])

@app.get("/api/{module}")
def list_records(module:str, limit:int=200, q:Optional[str]=None):
    if module not in MODULES:
        raise HTTPException(404,"Módulo no válido")
    m=MODULES[module]; c=conn()
    rows=c.execute("SELECT record_id,payload,created_at,updated_at FROM records WHERE module=? ORDER BY updated_at DESC LIMIT ?",(m,limit)).fetchall()
    out=[]
    for r in rows:
        p=json.loads(r["payload"]); p["_id"]=r["record_id"]; p["_updated_at"]=r["updated_at"]
        if q and q.lower() not in json.dumps(p,ensure_ascii=False).lower():
            continue
        out.append(p)
    c.close(); return out

@app.get("/api/{module}/{record_id}")
def get_record(module:str, record_id:str):
    if module not in MODULES: raise HTTPException(404,"Módulo no válido")
    c=conn(); r=c.execute("SELECT * FROM records WHERE module=? AND record_id=?",(MODULES[module],record_id)).fetchone(); c.close()
    if not r: raise HTTPException(404,"Registro no encontrado")
    p=json.loads(r["payload"]); p["_id"]=record_id; return p

@app.post("/api/{module}")
def create_record(module:str, rec:RecordIn):
    if module not in MODULES: raise HTTPException(404,"Módulo no válido")
    m=MODULES[module]; p=rec.payload.copy(); rid=rid_for(m,p)
    c=conn()
    if c.execute("SELECT 1 FROM records WHERE module=? AND record_id=?",(m,rid)).fetchone():
        rid=rid+"-"+uuid.uuid4().hex[:4].upper()
    if m=="Proyectos": p["Proyecto_ID"]=rid
    c.execute("INSERT INTO records VALUES(?,?,?,?,?)",(m,rid,json.dumps(p,ensure_ascii=False),now(),now()))
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",(now(),m,rid,"CREATE","Registro creado desde prototipo V0.2"))
    c.commit(); c.close()
    return {"ok":True,"id":rid}

@app.put("/api/{module}/{record_id}")
def update_record(module:str, record_id:str, rec:RecordIn):
    if module not in MODULES: raise HTTPException(404,"Módulo no válido")
    c=conn()
    if not c.execute("SELECT 1 FROM records WHERE module=? AND record_id=?",(MODULES[module],record_id)).fetchone():
        c.close(); raise HTTPException(404,"Registro no encontrado")
    c.execute("UPDATE records SET payload=?,updated_at=? WHERE module=? AND record_id=?",
              (json.dumps(rec.payload,ensure_ascii=False),now(),MODULES[module],record_id))
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",(now(),MODULES[module],record_id,"UPDATE","Registro actualizado"))
    c.commit(); c.close(); return {"ok":True}

@app.delete("/api/{module}/{record_id}")
def delete_record(module:str, record_id:str):
    if module not in MODULES: raise HTTPException(404,"Módulo no válido")
    c=conn(); c.execute("DELETE FROM records WHERE module=? AND record_id=?",(MODULES[module],record_id))
    c.execute("INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)",(now(),MODULES[module],record_id,"DELETE","Registro eliminado"))
    c.commit(); c.close(); return {"ok":True}

def _normalize_for_classifier(value):
    s=json.dumps(value,ensure_ascii=False).lower()
    s=unicodedata.normalize("NFD",s)
    return "".join(ch for ch in s if unicodedata.category(ch)!="Mn")

CLASSIFIER_LEXICON = {
    "G":{
        "strong":["representacion legal","facultades","gobernanza","padron","eleccion",
                  "interlocucion","junta transitoria","administrador judicial",
                  "legitimidad comunal","organo comunal","representacion fragmentada"],
        "weak":["comunal","judicial","sunarp","bdpi","consulta previa","directiva","fundacion comunal"]
    },
    "A":{
        "strong":["mapa de actores","capacidad de influencia","influencia alta",
                  "capacidad de movilizacion","movilizacion alta","alianza",
                  "actor critico","liderazgo"],
        "weak":["actor","organizacion","convocatoria","relacionamiento","roles"]
    },
    "D":{
        "strong":["demanda","demandas","solicitan","solicitud","compromiso","empleo",
                  "proveedores","beneficios","capacitacion","expectativas"],
        "weak":["agenda","atencion","pedido","requerimiento"]
    },
    "N":{
        "strong":["narrativa","facebook","medios digitales","redes sociales",
                  "notas periodisticas","prensa","publicaciones","tono negativo",
                  "no verificado","desinformacion"],
        "weak":["controversia","exposicion publica","reputacional","comentarios"]
    },
    "E":{
        "strong":["agua","pesca","maricultura","biodiversidad","pozo","ganadero",
                  "ganado","servidumbre","derechos superficiales","territorio","ambiental"],
        "weak":["saneamiento","acceso","rutas","agricultor","agricolas","bahia","transito"]
    },
    "I":{
        "strong":["convocatoria formal","cargos firmados","carta de invitacion",
                  "comunicacion institucional","trazabilidad","coordinacion institucional",
                  "oficio","subprefectura","proinversion","minem","fase de estructuracion",
                  "contrato/bases","concurso internacional","adjudicacion"],
        "weak":["institucional","resolucion","coordinacion","municipalidad","cronograma",
                "hitos","presentacion"]
    }
}

@app.post("/system/analyze")
def analyze(rec:RecordIn):
    text=_normalize_for_classifier(rec.payload)
    scores={d:0.0 for d in CLASSIFIER_LEXICON}
    evidence={d:[] for d in CLASSIFIER_LEXICON}

    for dim,sets in CLASSIFIER_LEXICON.items():
        for phrase in sets["strong"]:
            if phrase in text:
                scores[dim]+=4.0
                evidence[dim].append({"signal":phrase,"weight":4.0})
        for phrase in sets["weak"]:
            if phrase in text:
                scores[dim]+=1.5
                evidence[dim].append({"signal":phrase,"weight":1.5})

    # Reglas contextuales generales; no usan IDs de caso ni la dimensión esperada.
    if any(x in text for x in ["facebook","medios digitales","notas periodisticas","prensa","redes sociales"]):
        scores["N"]+=5.0; evidence["N"].append({"signal":"canal digital/periodístico","weight":5.0})
    if any(x in text for x in ["convocatoria formal","cargos firmados","fase de estructuracion","comunicacion institucional"]):
        scores["I"]+=5.0; evidence["I"].append({"signal":"acto/comunicación institucional trazable","weight":5.0})
    if "mapa de actores" in text or ("influencia" in text and "movilizacion" in text):
        scores["A"]+=5.0; evidence["A"].append({"signal":"influencia + movilización / mapa de actores","weight":5.0})
    if "demanda" in text or "demandas" in text:
        scores["D"]+=4.0; evidence["D"].append({"signal":"demanda explícita","weight":4.0})
    if any(x in text for x in ["agua","pozo","pesca","maricultura","derechos superficiales"]):
        scores["E"]+=3.0; evidence["E"].append({"signal":"componente ambiental/territorial explícito","weight":3.0})
    if "administrador judicial" in text and ("facultades" in text or "representacion legal" in text):
        scores["G"]+=6.0; evidence["G"].append({"signal":"facultades + representación/interlocución","weight":6.0})
    if "mina de sal" in text and any(x in text for x in ["enfrentamiento","control","posesion"]):
        scores["G"]+=3.0; evidence["G"].append({"signal":"disputa territorial por control/posesión","weight":3.0})

    ordered=sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    dim=ordered[0][0]
    top=ordered[0][1]
    second=ordered[1][1]
    margin=max(0.0,top-second)

    if top<=0:
        confidence=40
    else:
        confidence=round(min(94, 55 + min(24, top*1.5) + min(15, margin*1.5)))

    severity="Amarillo"
    critical_context=any(w in text for w in [
        "enfrentamiento","bloqueo","violencia","detenid","riesgo alto",
        "afectacion critica","condicion critica"
    ])
    extreme_context=any(w in text for w in ["fallecid","grave violencia","lesiones graves"])
    if critical_context:
        severity="Naranja"
    if extreme_context and dim!="N":
        severity="Rojo"
    if dim=="N" and severity=="Rojo":
        severity="Naranja"

    labels={"G":"Gobernanza y representación","A":"Actores e influencia",
            "D":"Demandas y compromisos","N":"Narrativas y señales digitales",
            "E":"Ambiental-territorial","I":"Institucional y trazabilidad"}

    return {
        "classifier_version":"0.5.1-calibracion",
        "dimension":dim,
        "dimension_label":labels[dim],
        "confidence":confidence,
        "nivel_sugerido":severity,
        "scores":{k:round(v,2) for k,v in scores.items()},
        "margin":round(margin,2),
        "evidence":evidence,
        "review_required":(confidence<70 or margin<3.0),
        "nota":"Sugerencia automática calibrada. No constituye referencia experta ni resultado final de tesis; requiere validación humana."
    }

@app.get("/system/audit")
def audit(limit:int=100):
    c=conn(); rows=c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?",(limit,)).fetchall(); c.close()
    return [dict(r) for r in rows]

@app.get("/system/export")
def export_db():
    scoped_db = SCOPE_DB.get()
    if scoped_db is None:
        raise HTTPException(status_code=403, detail="Seleccione un proyecto autorizado")
    return FileResponse(scoped_db, filename="mascli.db", media_type="application/octet-stream")



# ---------------------------------------------------------------------------
# MASCLI V0.4 - Motor de indicadores desagregados
# Estado: PROVISIONAL / PARA PROTOTIPADO Y CALIBRACIÓN
# ---------------------------------------------------------------------------
def _txt(*parts):
    return " ".join(str(x or "") for x in parts).lower()

def _contains(text, words):
    text=str(text or "").lower()
    return any(w.lower() in text for w in words)

def _pct(num, den):
    return 0.0 if not den else round(100.0*float(num)/float(den),2)

def _cap(x):
    return round(max(0.0,min(100.0,float(x))),2)

def _ind(code, score, confidence, method, evidence_count, explanation, availability="Disponible"):
    return {
        "code":code, "score":None if score is None else _cap(score),
        "confidence":confidence, "method":method, "evidence_count":int(evidence_count or 0),
        "explanation":explanation, "availability":availability
    }

def compute_indicators():
    meta=json.loads(scoped_config(INDICATOR_CONFIG).read_text(encoding="utf-8"))
    eventos=records_of("Eventos")
    actores=records_of("Actores")
    demandas=records_of("Demandas")
    compromisos=records_of("Compromisos")
    narrativas=records_of("Narrativas")
    alertas=records_of("Alertas")
    acciones=records_of("Acciones")
    directorio=records_of("Directorio_Territorial")

    result={d:[] for d in DIM_LABELS}

    # ---------------- G: Gobernanza ----------------
    gov_actors=[a for a in actores if _contains(_txt(a.get("Tipo_Actor"),a.get("Rol/Relacion"),a.get("Legitimidad/Representacion")),
                                                ["comunal","represent","fundación","administrador","ccsms"])]
    risky_leg=[a for a in gov_actors if _contains(a.get("Legitimidad/Representacion"),
                                                  ["fragment","limitad","validar","provisional","inciert","sin reconocimiento"])]
    result["G"].append(_ind("G1", _pct(len(risky_leg),max(1,len(gov_actors))), "Media-Alta",
        "Proporción de actores de gobernanza con legitimidad/representación fragmentada, limitada o pendiente de validar.",
        len(gov_actors), f"{len(risky_leg)} de {len(gov_actors)} actores de gobernanza presentan condiciones de representación que requieren validación."))

    g_events=[e for e in eventos if "G" in [dimension_code(e.get("Dimension_Principal")),dimension_code(e.get("Dimension_Secundaria"))]]
    g_high=[e for e in g_events if _contains(e.get("Relevancia_Preliminar"),["alta","crít","crit"])]
    g_alerts=[a for a in alertas if dimension_code(a.get("Dimension"))=="G" and is_open_state(a.get("Estado"))]
    g2=min(100, len(g_high)*8 + len(g_alerts)*18)
    result["G"].append(_ind("G2",g2,"Alta","Suma normalizada de eventos G de relevancia alta/crítica y alertas G activas.",
        len(g_high)+len(g_alerts),f"{len(g_high)} eventos G relevantes y {len(g_alerts)} alertas G activas."))

    conflict_words=["disputa","enfrentamiento","conflicto","facción","facciones","tensión","controversia"]
    g_conf=[e for e in g_events if _contains(_txt(e.get("Descripcion_Hecho"),e.get("Evidencia/Resultado"),e.get("Observaciones")),conflict_words)]
    n_conf=[n for n in narrativas if _contains(_txt(n.get("Tema"),n.get("Descripcion")),conflict_words)]
    result["G"].append(_ind("G3",min(100,(len(g_conf)+len(n_conf))*15),"Media-Alta",
        "Conteo normalizado de eventos y narrativas con términos de disputa/conflicto vinculados al entorno de gobernanza.",
        len(g_conf)+len(n_conf),f"Se identificaron {len(g_conf)} eventos y {len(n_conf)} narrativas con señales de conflictividad interna."))

    legal_words=["judicial","resolución","registr","sunarp","bdpi","consulta previa","tribunal","apelación","fiscal"]
    legal=[e for e in eventos if _contains(_txt(e.get("Tipo_Evento"),e.get("Descripcion_Hecho"),e.get("Evidencia/Resultado"),e.get("Observaciones")),legal_words)]
    result["G"].append(_ind("G4",min(100,len(legal)*12),"Alta",
        "Conteo normalizado de eventos con elementos judiciales, registrales, BDPI/consulta previa o apelaciones.",
        len(legal),f"{len(legal)} eventos contienen factores jurídicos/registrales relevantes."))

    lead_words=["elección","electoral","padrón","junta","administrador","liderazgo","directiva","empadron"]
    lead=[e for e in eventos if _contains(_txt(e.get("Tipo_Evento"),e.get("Descripcion_Hecho"),e.get("Evidencia/Resultado")),lead_words)]
    result["G"].append(_ind("G5",min(100,len(lead)*10),"Media-Alta",
        "Conteo normalizado de eventos relacionados con elecciones, padrón, directivas o administraciones provisionales.",
        len(lead),f"{len(lead)} eventos reflejan cambios o procesos de liderazgo/interlocución."))

    # ---------------- A: Actores ----------------
    highinf=[a for a in actores if _contains(a.get("Influencia"),["alta"]) and _contains(a.get("Posicion_Proyecto"),["crít","opos","no determinado"])]
    result["A"].append(_ind("A1",_pct(len(highinf),max(1,len(actores))),"Media-Alta",
        "Proporción de actores con influencia alta y posición crítica/opositora/no determinada.",
        len(actores),f"{len(highinf)} de {len(actores)} actores analíticos cumplen la condición de riesgo."))

    mobil=[a for a in actores if _contains(a.get("Capacidad_Movilizacion"),["alta","media-alta"])]
    result["A"].append(_ind("A2",_pct(len(mobil),max(1,len(actores))),"Alta",
        "Proporción de actores con capacidad de movilización alta o media-alta.",
        len(actores),f"{len(mobil)} de {len(actores)} actores tienen capacidad de movilización relevante."))

    # No historical actor-position series exists in the structured base.
    result["A"].append(_ind("A3",None,"Baja","No calculable de forma robusta: falta serie histórica estructurada de posición por actor.",
        0,"La base almacena una posición vigente por actor, pero no un historial suficiente para medir cambios.",availability="Datos insuficientes"))

    # Centrality proxy: concentration of actor mentions as principal actor in events.
    mentions={}
    for e in eventos:
        actor=str(e.get("Actor_Principal") or "").strip()
        if actor: mentions[actor]=mentions.get(actor,0)+1
    top=max(mentions.values()) if mentions else 0
    a4=_pct(top,max(1,len(eventos)))
    result["A"].append(_ind("A4",a4,"Media",
        "Proxy de centralidad: participación del actor más mencionado como actor principal sobre el total de eventos.",
        len(eventos),f"El actor más mencionado concentra {top} de {len(eventos)} eventos. Requiere reemplazo futuro por análisis de red formal."))

    leg_risk=[a for a in actores if _contains(_txt(a.get("Legitimidad/Representacion"),a.get("Observaciones")),["validar","fragment","limitad","provisional","inciert","por confirmar"])]
    result["A"].append(_ind("A5",_pct(len(leg_risk),max(1,len(actores))),"Media",
        "Proporción de actores analíticos con legitimidad/representación pendiente, provisional o limitada.",
        len(actores),f"{len(leg_risk)} de {len(actores)} actores requieren cautela de legitimidad/representación."))

    pol_words=["polar","facción","alianza","oposición","tensión","confront","disputa","enfrent"]
    pol=[e for e in eventos if _contains(_txt(e.get("Descripcion_Hecho"),e.get("Observaciones")),pol_words)]
    pol+= [n for n in narrativas if _contains(_txt(n.get("Tema"),n.get("Descripcion")),pol_words)]
    result["A"].append(_ind("A6",min(100,len(pol)*12),"Media",
        "Conteo normalizado de eventos/narrativas con señales de polarización, facciones, alianzas o tensión.",
        len(pol),f"{len(pol)} registros contienen señales relacionales de polarización o tensión."))

    # ---------------- D: Demandas ----------------
    open_d=[d for d in demandas if is_open_state(d.get("Estado"))]
    result["D"].append(_ind("D1",min(100,len(open_d)*7),"Alta",
        "Número de demandas abiertas normalizado a 0–100.",
        len(open_d),f"{len(open_d)} demandas permanecen abiertas o no cerradas."))

    rec=[d for d in demandas if _contains(d.get("Recurrencia"),["alta"])]
    result["D"].append(_ind("D2",_pct(len(rec),max(1,len(demandas))),"Alta",
        "Porcentaje de demandas con recurrencia alta.",
        len(demandas),f"{len(rec)} de {len(demandas)} demandas están marcadas con recurrencia alta."))

    overdue=[c for c in compromisos if _contains(c.get("Estado"),["vencid"])]
    result["D"].append(_ind("D3",_pct(len(overdue),max(1,len(compromisos))),"Alta",
        "Porcentaje de compromisos en estado vencido.",
        len(compromisos),f"{len(overdue)} de {len(compromisos)} compromisos están vencidos según el registro actual."))

    slow=[d for d in demandas if _contains(d.get("Estado"),["nueva","evaluada"])]
    pend=[c for c in compromisos if _contains(c.get("Estado"),["pendiente"])]
    d4=min(100,(len(slow)+len(pend))*10)
    result["D"].append(_ind("D4",d4,"Baja-Media",
        "Proxy por demandas en estado inicial y compromisos pendientes. No sustituye un cálculo de días de respuesta.",
        len(slow)+len(pend),f"{len(slow)} demandas están en estados iniciales y {len(pend)} compromisos están pendientes.",
        availability="Proxy por datos incompletos"))

    gap_words=["futuro adjudicatario","por definir","según etapa","segun etapa","según competencia","segun competencia","entidad competente","instancia técnica","instancia tecnica"]
    gap=[d for d in demandas if _contains(_txt(d.get("Entidad_Competente"),d.get("Observaciones")),gap_words)]
    result["D"].append(_ind("D5",_pct(len(gap),max(1,len(demandas))),"Media-Alta",
        "Proporción de demandas cuya atención depende de futura etapa, entidad o competencia por precisar.",
        len(demandas),f"{len(gap)} de {len(demandas)} demandas presentan brecha expectativa–competencia/etapa."))

    # ---------------- N: Narrativas ----------------
    critical=[n for n in narrativas if _contains(n.get("Tono"),["negativo"]) and _contains(n.get("Intensidad"),["alta"])]
    result["N"].append(_ind("N1",_pct(len(critical),max(1,len(narrativas))),"Alta",
        "Porcentaje de narrativas con tono negativo e intensidad alta.",
        len(narrativas),f"{len(critical)} de {len(narrativas)} narrativas cumplen el criterio de contenido crítico."))

    active_n=[n for n in narrativas if is_open_state(n.get("Estado"))]
    result["N"].append(_ind("N2",_pct(len(active_n),max(1,len(narrativas))),"Media",
        "Proporción de narrativas que permanecen en seguimiento/activas. Es un proxy de persistencia, no una tasa temporal.",
        len(narrativas),f"{len(active_n)} de {len(narrativas)} narrativas permanecen abiertas/en seguimiento.",availability="Proxy temporal"))

    dig_conf_words=["controvers","conflicto","tensión","disputa","enfrent","polar","cuestion"]
    dig_conf=[n for n in narrativas if _contains(_txt(n.get("Tema"),n.get("Descripcion")),dig_conf_words)]
    result["N"].append(_ind("N3",_pct(len(dig_conf),max(1,len(narrativas))),"Media-Alta",
        "Porcentaje de narrativas con términos asociados a confrontación o controversia.",
        len(narrativas),f"{len(dig_conf)} de {len(narrativas)} narrativas muestran señales de confrontación/controversia."))

    unver=[n for n in narrativas if _contains(n.get("Nivel_Verificacion"),["e -","no verificada"]) or _contains(n.get("Nivel_Verificacion"),["d - opinión","d - opinion"])]
    result["N"].append(_ind("N4",_pct(len(unver),max(1,len(narrativas))),"Alta",
        "Porcentaje de narrativas clasificadas como opinión/narrativa o no verificadas.",
        len(narrativas),f"{len(unver)} de {len(narrativas)} narrativas requieren cautela de verificación."))

    themes=set(str(n.get("Tema") or "").strip().lower() for n in narrativas if str(n.get("Tema") or "").strip())
    result["N"].append(_ind("N5",min(100,len(themes)*12),"Baja-Media",
        "Número de temas distintos normalizado como proxy de diversificación de la agenda narrativa.",
        len(themes),f"El monitoreo registra {len(themes)} temas distintos. Se requiere una serie temporal mayor para identificar emergencia real.",
        availability="Proxy por serie limitada"))

    # ---------------- E: Ambiental-territorial ----------------
    env_words=["agua","pesca","maricultura","ambient","territor","servid","biodivers","pozo","ganad","agric","polvo","bahía","bahia","tránsito","transito"]
    env_dem=[d for d in demandas if dimension_code(d.get("Dimension"))=="E" or _contains(_txt(d.get("Tema"),d.get("Descripcion")),env_words)]
    env_evt=[e for e in eventos if "E" in [dimension_code(e.get("Dimension_Principal")),dimension_code(e.get("Dimension_Secundaria"))] or _contains(e.get("Descripcion_Hecho"),env_words)]
    active_env_dem=[d for d in env_dem if is_open_state(d.get("Estado"))]
    result["E"].append(_ind("E1",min(100,len(active_env_dem)*8 + len(env_evt)*4),"Alta",
        "Suma normalizada de demandas ambientales abiertas y eventos ambientales/territoriales.",
        len(active_env_dem)+len(env_evt),f"{len(active_env_dem)} demandas ambientales abiertas y {len(env_evt)} eventos relacionados."))

    env_rec=[d for d in env_dem if _contains(d.get("Recurrencia"),["alta"])]
    result["E"].append(_ind("E2",_pct(len(env_rec),max(1,len(env_dem))),"Alta",
        "Porcentaje de demandas ambientales/territoriales con recurrencia alta.",
        len(env_dem),f"{len(env_rec)} de {len(env_dem)} demandas ambientales son recurrentes."))

    livelihood_words={"pesca":["pesca","pescador"],"maricultura":["maricult"],"ganadería":["ganad"],"agricultura":["agric"],"transporte":["transport"]}
    exposed=[]
    corpus=" ".join(_txt(d.get("Actor/Grupo"),d.get("Tema"),d.get("Descripcion")) for d in demandas)+" "+" ".join(_txt(e.get("Actor_Principal"),e.get("Descripcion_Hecho")) for e in eventos)
    for sector,words in livelihood_words.items():
        if _contains(corpus,words): exposed.append(sector)
    result["E"].append(_ind("E3",min(100,len(exposed)*18),"Media-Alta",
        "Diversidad de medios de vida identificados en demandas/eventos, normalizada a 0–100.",
        len(exposed),f"Se identifican {len(exposed)} sectores: {', '.join(exposed) if exposed else 'ninguno estructurado'}."))

    terr_words=["territorio","servidumbre","tránsito","transito","superficie","acceso","delimitación","delimitacion","ruta","pozo hierba blanca"]
    terr=[x for x in demandas+eventos if _contains(_txt(x.get("Tema"),x.get("Descripcion"),x.get("Descripcion_Hecho"),x.get("Observaciones")),terr_words)]
    result["E"].append(_ind("E4",min(100,len(terr)*10),"Alta",
        "Conteo normalizado de registros con uso de territorio, servidumbres, accesos, rutas o delimitación.",
        len(terr),f"{len(terr)} registros contienen asuntos de territorio/acceso/servidumbre."))

    env_verified=[e for e in env_evt if _contains(e.get("Nivel_Verificacion"),["a -","b -"])]
    env_perceived=[e for e in env_evt if _contains(e.get("Nivel_Verificacion"),["c -","d -","e -"])]
    result["E"].append(_ind("E5",_pct(len(env_perceived),max(1,len(env_verified)+len(env_perceived))),"Media-Alta",
        "Porcentaje de eventos ambientales sustentados en percepción/opinión/no verificado frente al total ambiental con nivel de verificación.",
        len(env_verified)+len(env_perceived),f"{len(env_perceived)} eventos ambientales se basan en percepción/opinión y {len(env_verified)} están verificados/corroborados."))

    # ---------------- I: Institucional ----------------
    i_alerts=[a for a in alertas if dimension_code(a.get("Dimension"))=="I" and is_open_state(a.get("Estado"))]
    alert_map={str(a.get("ID_Alerta") or a.get("_id")):dimension_code(a.get("Dimension")) for a in alertas}
    i_actions=[a for a in acciones if alert_map.get(str(a.get("ID_Alerta") or ""))=="I" and _contains(a.get("Estado"),["pendiente","en curso","vencid"])]
    result["I"].append(_ind("I1",min(100,len(i_alerts)*18+len(i_actions)*8),"Media-Alta",
        "Alertas institucionales activas y acciones institucionales pendientes como proxy de coordinación residual.",
        len(i_alerts)+len(i_actions),f"{len(i_alerts)} alertas I activas y {len(i_actions)} acciones I pendientes/en curso."))

    msg_words=["contradic","desinform","precisar","aclar","carácter informativo","caracter informativo","alcance","no asumir"]
    msg=[e for e in eventos if dimension_code(e.get("Dimension_Principal"))=="I" or dimension_code(e.get("Dimension_Secundaria"))=="I"]
    msg_risk=[e for e in msg if _contains(_txt(e.get("Descripcion_Hecho"),e.get("Evidencia/Resultado"),e.get("Observaciones")),msg_words)]
    result["I"].append(_ind("I2",_pct(len(msg_risk),max(1,len(msg))),"Media",
        "Porcentaje de eventos institucionales que requieren precisión, aclaración o cautela de mensaje.",
        len(msg),f"{len(msg_risk)} de {len(msg)} eventos institucionales presentan señales de coherencia/mensaje por gestionar."))

    open_i_alerts=len(i_alerts)
    open_actions=len([a for a in acciones if _contains(a.get("Estado"),["pendiente","en curso","vencid"])])
    result["I"].append(_ind("I3",min(100,open_i_alerts*12+open_actions*4),"Baja-Media",
        "Proxy basado en alertas institucionales activas y acciones abiertas. No es un cálculo de días de respuesta.",
        open_i_alerts+open_actions,f"{open_i_alerts} alertas I activas y {open_actions} acciones generales abiertas.",availability="Proxy por fechas incompletas"))

    active_alerts=[a for a in alertas if is_open_state(a.get("Estado"))]
    noresp=[a for a in active_alerts if not str(a.get("Responsable") or "").strip() or _contains(a.get("Responsable"),["por asignar"])]
    result["I"].append(_ind("I4",_pct(len(noresp),max(1,len(active_alerts))),"Alta",
        "Porcentaje de alertas activas sin responsable definido o marcadas 'Por asignar'.",
        len(active_alerts),f"{len(noresp)} de {len(active_alerts)} alertas activas no tienen responsable efectivo."))

    key_records=eventos+demandas+alertas+acciones+narrativas
    with_source=[]
    for r in key_records:
        src=r.get("Fuente_ID")
        ev=r.get("Evidencia") or r.get("Evidencia/Resultado") or r.get("Evidencia_Cierre")
        if str(src or "").strip() or str(ev or "").strip(): with_source.append(r)
    completeness=_pct(len(with_source),max(1,len(key_records)))
    result["I"].append(_ind("I5",100-completeness,"Alta",
        "Riesgo inverso del porcentaje de registros clave con Fuente_ID o evidencia asociada.",
        len(key_records),f"{len(with_source)} de {len(key_records)} registros clave cuentan con fuente/evidencia estructurada ({completeness}%)."))

    territories=set()
    for x in eventos+demandas:
        t=str(x.get("Territorio") or "").strip()
        if t: territories.add(t.lower())
    # Directory contains institution/locality records; use a conservative reference of distinct territorial sections when available.
    dir_places=set()
    for x in directorio:
        t=str(x.get("Sección territorial") or x.get("Lugar / ámbito") or "").strip()
        if t: dir_places.add(t.lower())
    denom=max(1,len(dir_places) or len(territories))
    coverage=min(100,_pct(len(territories),denom))
    result["I"].append(_ind("I6",100-coverage,"Media",
        "Riesgo inverso de la cobertura: territorios presentes en eventos/demandas frente a ámbitos diferenciados del directorio.",
        len(territories),f"Se cubren {len(territories)} territorios en registros operativos frente a {denom} ámbitos de referencia; cobertura estimada {coverage}%.",
        availability="Indicador de cobertura aproximada"))

    # attach metadata and aggregate each dimension from available indicators
    dim_scores={}
    availability={}
    flat=[]
    for d,inds in result.items():
        meta_by={m["code"]:m for m in meta[d]}
        available=[x["score"] for x in inds if x["score"] is not None]
        dim_scores[d]=round(sum(available)/len(available),2) if available else 0.0
        availability[d]=round(100*len(available)/len(inds),1) if inds else 0
        for x in inds:
            x.update(meta_by.get(x["code"],{}))
            x["dimension"]=d
            x["dimension_label"]=DIM_LABELS[d]
            flat.append(x)
    return {
        "dimensions":result,
        "dimension_scores":dim_scores,
        "availability":availability,
        "indicators":flat,
        "method_note":"V0.4 usa reglas/proxies transparentes. Indicadores con datos insuficientes se excluyen del promedio dimensional.",
        "validation_status":"PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS"
    }

# Redefine IRSA to use the V0.4 indicator-level scores.
def compute_irsa():
    cfg=load_irsa_config()
    ind=compute_indicators()
    scores=ind["dimension_scores"]
    weights=cfg["weights"]
    irsa=round(sum(float(scores.get(d,0))*float(weights.get(d,0)) for d in DIM_LABELS),2)
    level="Rojo"
    for name,(lo,hi) in cfg["thresholds"].items():
        if float(lo) <= irsa <= float(hi):
            level=name
            break

    # top indicator drivers
    drivers=[]
    for x in ind["indicators"]:
        if x["score"] is None:
            continue
        drivers.append({
            "dimension":x["dimension"],"dimension_label":x["dimension_label"],
            "type":"indicador","id":x["code"],"label":x["name"],
            "points":round(x["score"],2),"confidence":x["confidence"],
            "explanation":x["explanation"]
        })
    drivers=sorted(drivers,key=lambda x:x["points"],reverse=True)[:15]

    return {
        "irsa":irsa,"level":level,"scores":scores,"weights":weights,
        "thresholds":cfg["thresholds"],"drivers":drivers,
        "details":ind["dimensions"],"availability":ind["availability"],
        "indicators":ind["indicators"],"config_version":"0.4-indicators",
        "status":"PROVISIONAL / PENDIENTE DE VALIDACIÓN DE EXPERTOS",
        "notes":[
            "El IRSA V0.4 se calcula desde indicadores desagregados G1–I6.",
            "Los indicadores no calculables por falta de datos se excluyen del promedio de su dimensión.",
            "Los métodos actuales son reglas/proxies transparentes para prototipado; requieren validación y calibración."
        ]
    }

@app.get("/system/indicators")
def indicators_endpoint():
    return compute_indicators()



@app.get("/system/model-status")
def model_status():
    return json.loads(MODEL_STATUS.read_text(encoding="utf-8"))

@app.get("/system/canonical-entities")
def canonical_entities():
    if SCOPE_ID.get() != ("MASCLI","PRJ-SECHURA"):return {}
    return json.loads(CANONICAL_ENTITIES.read_text(encoding="utf-8"))

@app.get("/system/project-coordinates")
def project_coordinates(project_id: str = "PRJ-SECHURA"):
    """Geometría pública de referencia vinculada al catálogo de proyectos."""
    if SCOPE_ID.get() != ("MASCLI","PRJ-SECHURA"):raise HTTPException(404,"Sin cartografía registrada para este proyecto")
    data=json.loads(PROJECT_COORDINATES.read_text(encoding="utf-8"))
    if str(data.get("project_id")) != str(project_id):
        raise HTTPException(status_code=404, detail="El proyecto no tiene coordenadas registradas")
    return data

@app.get("/system/validation-template")
def validation_template():
    meta=json.loads(scoped_config(INDICATOR_CONFIG).read_text(encoding="utf-8"))
    rows=[]
    for d,items in meta.items():
        for item in items:
            rows.append({
                "dimension":d,
                "code":item["code"],
                "name":item["name"],
                "definition":item["definition"],
                "expert_1":None,"expert_2":None,"expert_3":None,"expert_4":None,"expert_5":None,
                "aiken_v":None,
                "decision":"Pendiente"
            })
    return {"status":"PENDIENTE","rows":rows}


# RC 2.0: laboratorio documental; lectura local determinista, sin servicios externos.
from io import BytesIO
from collections import Counter
from docx import Document as WordDocument

DOC_TERMS = {
 'Representatividad y gobernanza':['representatividad','mandato','directiva','elección','asamblea','comunidad','vigencia','junta'],
 'Demandas e intereses':['demanda','solicitud','preocupación','empleo','proveedores','capacitación','petición','reclamo'],
 'Compromisos y trazabilidad':['compromiso','acuerdo','responsable','plazo','seguimiento','cumplimiento','acta'],
 'Controversias y hechos compartidos':['controversia','versión','evidencia','verificación','fuente','denuncia','cuestionamiento'],
 'Diálogo y construcción de consensos':['diálogo','reunión','negociación','participación','consenso','facilitación','mesa'],
 'Oportunidades de valor compartido':['oportunidad','desarrollo','inversión','beneficio','contratación','servicios','productiva'],
 'Territorio y ambiente':['territorio','ambiental','agua','suelo','salud','impacto','área de influencia']
}
DOC_ACTIONS={
 'Representatividad y gobernanza':'Comprobar mandato, vigencia y fuentes de representación antes de formalizar interlocución.',
 'Demandas e intereses':'Diferenciar demandas explícitas de intereses expresamente documentados y evitar inferir motivaciones.',
 'Compromisos y trazabilidad':'Contrastar actas, responsables y fechas antes de registrar compromisos como confirmados.',
 'Controversias y hechos compartidos':'Abrir ficha de hechos por verificar, reunir fuentes y registrar versiones sin dar por probada ninguna.',
 'Diálogo y construcción de consensos':'Evaluar condiciones de participación informada y posibles preguntas para una agenda de diálogo.',
 'Oportunidades de valor compartido':'Evaluar beneficios potenciales, restricciones, responsable institucional y viabilidad antes de prometer acciones.',
 'Territorio y ambiente':'Solicitar contraste técnico territorial y distinguir percepciones de impactos confirmados.'
}

def doc_extract(blob:bytes,filename:str):
    ext=Path(filename).suffix.lower(); chunks=[]
    if ext=='.pdf':
        import fitz
        with fitz.open(stream=blob,filetype='pdf') as pdf:
            if len(pdf)>100: raise HTTPException(413,'El PDF supera 100 páginas')
            for i,p in enumerate(pdf):
                t=p.get_text('text').strip()
                if t:chunks.append((f'Página {i+1}',t))
    elif ext=='.docx':
        d=WordDocument(BytesIO(blob))
        for i,p in enumerate(d.paragraphs):
            if p.text.strip():chunks.append((f'Párrafo {i+1}',p.text.strip()))
        for ti,t in enumerate(d.tables):
            for ri,row in enumerate(t.rows):
                x=' | '.join(c.text.strip() for c in row.cells)
                if x.strip(' |'):chunks.append((f'Tabla {ti+1}, fila {ri+1}',x))
    elif ext in ('.txt','.md'):
        for i,line in enumerate(blob.decode('utf-8-sig',errors='replace').splitlines()):
            if line.strip():chunks.append((f'Línea {i+1}',line.strip()))
    else:raise HTTPException(415,'Use PDF con texto seleccionable, DOCX, TXT o MD')
    return chunks

def document_insights(chunks):
    items=[];counts=Counter();max_matches=75
    for loc,text_line in chunks:
        # Divide lengthy pages into line segments to attach a more useful excerpt and provenance.
        segments=re.split(r'(?<=[.!?])\s+|\n+',text_line)
        for segment in segments:
            segment=' '.join(segment.split())
            if len(segment)<20:continue
            simplified=unicodedata.normalize('NFKD',segment.lower()).encode('ascii','ignore').decode('ascii')
            for domain,words in DOC_TERMS.items():
                hits=[w for w in words if unicodedata.normalize('NFKD',w).encode('ascii','ignore').decode('ascii') in simplified]
                if hits and counts[domain]<12 and len(items)<max_matches:
                    items.append({'id':f'H{len(items)+1:03}', 'tema':domain,'ubicacion':loc,'fragmento':segment[:480], 'terminos':hits[:6], 'accion_sugerida':DOC_ACTIONS[domain], 'estado':'Candidato no verificado'})
                    counts[domain]+=1
    return items,dict(counts)

@app.post('/system/document-lab/analyze')
async def document_lab_analyze(file:UploadFile=File(...),project_id:str=Form('PRJ-SECHURA')):
    name=_safe_upload_name(file.filename or 'documento.txt')
    if Path(name).suffix.lower() not in {'.pdf','.docx','.txt','.md'}:raise HTTPException(415,'Tipo de documento no compatible')
    blob=await file.read(MAX_UPLOAD_BYTES+1)
    if len(blob)>MAX_UPLOAD_BYTES:raise HTTPException(413,'Archivo demasiado grande')
    if not blob:raise HTTPException(400,'Archivo vacío')
    try:chunks=doc_extract(blob,name)
    except HTTPException:raise
    except Exception as err:raise HTTPException(422,f'No se puede leer el documento: {type(err).__name__}')
    if not chunks:raise HTTPException(422,'No se detectó texto extraíble. Los PDF escaneados requieren OCR externo.')
    items,counts=document_insights(chunks)
    return {'version':'2.1','project_id':project_id,'filename':name,'sha256':hashlib.sha256(blob).hexdigest(), 'generated_at':now(),
     'text_sections':len(chunks),'items':items,'themes':counts,
     'recommendations':[{'tema':k,'accion':DOC_ACTIONS[k],'hallazgos_candidatos':v} for k,v in sorted(counts.items(),key=lambda p:-p[1])],
     'method':'Detección léxica local por categorías; sin modelo generativo, OCR ni búsqueda semántica.',
     'limitations':['Los fragmentos son hallazgos candidatos, NO hechos corroborados.','No se infiere la intención, legitimidad ni delito de personas o colectivos.',
      'La coincidencia de palabras no demuestra un compromiso, acuerdo ni conflicto.','El documento no se almacena y ninguna sugerencia se escribe automáticamente en la base de datos.',
      'El prototipo no tiene autenticación; no suba información personal ni confidencial a servidores públicos.']}

@app.post('/system/document-lab/report.docx')
async def document_lab_report(file:UploadFile=File(...),project_id:str=Form('PRJ-SECHURA')):
    data=await document_lab_analyze(file,project_id)
    d=WordDocument();d.add_heading('MASCLI RC 2.0 | Informe de lectura documental',0)
    d.add_paragraph('PROTOTIPO · Material para revisión técnica, no informe oficial')
    for k in ('filename','project_id','sha256','generated_at','method'):
        d.add_paragraph(f'{k}: {data[k]}')
    d.add_heading('Áreas temáticas y acciones propuestas',level=1)
    for item in data['recommendations']:
        d.add_heading(item['tema'],level=2);d.add_paragraph(f"{item['hallazgos_candidatos']} fragmentos candidatos. {item['accion']}")
    d.add_heading('Fragmentos con trazabilidad',level=1)
    for x in data['items']:
        d.add_heading(f"{x['id']} — {x['tema']} ({x['ubicacion']})",level=3)
        d.add_paragraph(x['fragmento']);d.add_paragraph(x['accion_sugerida'])
    d.add_heading('Limitaciones y revisión',level=1)
    for v in data['limitations']:d.add_paragraph(v,style='List Bullet')
    out=BytesIO();d.save(out);out.seek(0)
    return StreamingResponse(out,media_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document',headers={'Content-Disposition':'attachment; filename="MASCLI_RC20_Lectura_Documental.docx"'})


# MASCLI RC 2.1 — comparación asistida y bandeja de verificación.
# NO usa IA generativa. Las diferencias son candidatas a contrastación.
from pydantic import Field
from difflib import SequenceMatcher

def rc21_tables():
    with conn() as c:
        c.execute("""CREATE TABLE IF NOT EXISTS document_review (
          id TEXT PRIMARY KEY, project_id TEXT NOT NULL, source_file TEXT NOT NULL,
          source_sha256 TEXT NOT NULL, location TEXT NOT NULL, theme TEXT NOT NULL,
          excerpt TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
          reviewer TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          UNIQUE(project_id,source_sha256,location,theme,excerpt)
        )""")

class ReviewBatch(BaseModel):
    project_id:str='PRJ-SECHURA'
    filename:str
    sha256:str
    items:list[dict]

class ReviewDecision(BaseModel):
    status:str
    reviewer:str=''
    note:str=''

@app.post('/system/document-lab/review/import')
def review_import(payload:ReviewBatch):
    rc21_tables()
    if not re.fullmatch(r'[0-9a-f]{64}',payload.sha256):raise HTTPException(422,'SHA256 inválido')
    if len(payload.items)>75:raise HTTPException(413,'Máximo 75 hallazgos')
    count=0
    with conn() as c:
        for x in payload.items:
            theme=str(x.get('tema',''))[:140];ex=str(x.get('fragmento',''))[:480];loc=str(x.get('ubicacion',''))[:140]
            if not ex or not loc:continue
            uid=uuid.uuid4().hex
            cur=c.execute("""INSERT OR IGNORE INTO document_review
              (id,project_id,source_file,source_sha256,location,theme,excerpt,action,status,reviewer,note,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
              (uid,payload.project_id[:120],payload.filename[:200],payload.sha256,loc,theme,ex,str(x.get('accion_sugerida',''))[:500],
               'pendiente','','',now(),now()))
            count+=cur.rowcount
    return {'ok':True,'new_items':count,'message':'Sólo se guardaron extractos de revisión, no los archivos originales.'}

@app.get('/system/document-lab/review')
def review_list(project_id:str='PRJ-SECHURA',status:str=''):
    rc21_tables()
    with conn() as c:
        q='SELECT * FROM document_review WHERE project_id=?'; params=[project_id]
        if status:q+=' AND status=?';params.append(status)
        data=[dict(r) for r in c.execute(q+' ORDER BY created_at DESC LIMIT 500',params).fetchall()]
    return {'items':data,'total':len(data),'limitations':'Revisado no implica verdad certificada: comprobar fuente y documentación.'}

@app.patch('/system/document-lab/review/{item_id}')
def review_decide(item_id:str,decision:ReviewDecision):
    rc21_tables()
    if decision.status not in ('pendiente','aceptado_para_revision','descartado','corroborado_documentalmente'):
        raise HTTPException(422,'Estado no permitido')
    if decision.status=='corroborado_documentalmente' and not decision.note.strip():
        raise HTTPException(422,'La corroboración requiere nota sobre evidencia contrastada')
    with conn() as c:
        cur=c.execute('UPDATE document_review SET status=?, reviewer=?, note=?, updated_at=? WHERE id=?',
          (decision.status,decision.reviewer[:120],decision.note[:1500],now(),item_id))
        if not cur.rowcount:raise HTTPException(404,'Hallazgo no encontrado')
        c.execute('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)',
          (now(),'Laboratorio_Documental',item_id,'REVIEW',decision.status+' | '+decision.reviewer[:120]))
    return {'ok':True,'id':item_id,'status':decision.status}

def _fingerprint(s):
    s=unicodedata.normalize('NFKD',s.lower()).encode('ascii','ignore').decode('ascii')
    return {w for w in re.findall(r'[a-z0-9]{5,}',s) if w not in {'sobre','entre','desde','hasta','estos','estas','donde','para','tiene','sobre','como','documento','proyecto','social','sechura','tambien','dicho','segun'}}

@app.post('/system/document-lab/compare')
async def rc21_compare(file_a:UploadFile=File(...),file_b:UploadFile=File(...),project_id:str=Form('PRJ-SECHURA')):
    docs=[]
    for f in (file_a,file_b):
        name=_safe_upload_name(f.filename or 'documento.txt')
        if Path(name).suffix.lower() not in {'.pdf','.docx','.txt','.md'}:raise HTTPException(415,'Formato no permitido')
        blob=await f.read(MAX_UPLOAD_BYTES+1)
        if not blob or len(blob)>MAX_UPLOAD_BYTES:raise HTTPException(413,'Tamaño inválido')
        chunks=doc_extract(blob,name)
        if not chunks:raise HTTPException(422,'Documento sin texto extraíble')
        items,_=document_insights(chunks)
        docs.append({'filename':name,'sha256':hashlib.sha256(blob).hexdigest(),'items':items})
    a,b=docs
    candidates=[]
    for ia in a['items']:
        fa=_fingerprint(ia['fragmento'])
        if not fa:continue
        for ib in b['items']:
            if ia['tema']!=ib['tema']:continue
            fb=_fingerprint(ib['fragmento']);overlap=fa&fb
            if len(overlap)<2:continue
            similarity=len(overlap)/max(1,len(fa|fb))
            if similarity<.11:continue
            candidates.append({'tema':ia['tema'],'a':{'ubicacion':ia['ubicacion'],'fragmento':ia['fragmento']},
              'b':{'ubicacion':ib['ubicacion'],'fragmento':ib['fragmento']},
              'terminos_comunes':sorted(overlap)[:10], 'coincidencia_lexica':round(similarity,2),
              'tipo':'Coincidencia temática; verificar diferencias entre versiones',
              'advertencia':'No constituye contradicción demostrada ni acuerdo confirmado.'})
    candidates.sort(key=lambda x:-x['coincidencia_lexica'])
    return {'version':'2.1','project_id':project_id,'documents':[{k:v for k,v in d.items() if k!='items'} for d in docs],
      'comparaciones':candidates[:40], 'total_candidatos':len(candidates),
      'method':'Comparación léxica local, misma categoría y términos distintivos compartidos; no comprensión semántica.',
      'limitations':['Las coincidencias no prueban contradicciones.','Confirmar identidad de actores, fechas y validez documental manualmente.',
        'Los documentos no se guardan ni se integran automáticamente a la base maestra.']}


# RC 2.4 — análisis textual local transparente; no extrae contenidos de plataformas.
from collections import Counter

_RC24_TERMS = {
 "Gobernanza y representación": ("directiva", "eleccion", "presidente", "asamblea", "representacion", "comunidad campesina", "administracion", "dirigente"),
 "Territorio y tierras": ("territorio", "tierras", "concesion", "servidumbre", "predio", "linderos", "ocupacion"),
 "Empleo y economía local": ("empleo", "trabajo", "contratacion", "proveedor", "beneficio", "salario", "inversion"),
 "Ambiente y agua": ("agua", "contaminacion", "ambiente", "impacto", "polvo", "residuo", "ecosistema"),
 "Diálogo y compromisos": ("dialogo", "reunion", "acuerdo", "compromiso", "mesa de trabajo", "informacion", "consulta"),
 "Protesta y conflictividad": ("protesta", "paro", "bloqueo", "movilizacion", "conflicto", "denuncia", "rechazo"),
 "Seguridad y emergencias": ("accidente", "amenaza", "riesgo", "emergencia", "seguridad", "evacuacion"),
}
_RC24_SIGNALS={
 "Movilización anunciada": ("paro", "marcha", "movilizacion", "bloqueo", "planton"),
 "Demanda o reclamo": ("exigimos", "reclamamos", "solicitamos", "demanda", "incumplimiento"),
 "Convocatoria a reunión": ("convocatoria", "asamblea", "reunion", "mesa de dialogo"),
 "Información no corroborada": ("dicen que", "se rumorea", "supuestamente", "trascendio", "al parecer"),
}

def _rc24_norm(t):
    return ''.join(ch for ch in unicodedata.normalize('NFKD',str(t or '').lower()) if not unicodedata.combining(ch))

class DigitalAnalysisIn(BaseModel):
    text: str
    project_id: str = 'PRJ-SECHURA'
    source_url: str = ''

@app.post('/system/intelligence/analyze-text')
def rc24_analyze_text(payload:DigitalAnalysisIn):
    content=payload.text.strip()
    if not content: raise HTTPException(422,'Ingrese el texto transcrito de la publicación.')
    if len(content)>20000: raise HTTPException(413,'Máximo 20 000 caracteres.')
    norm=_rc24_norm(content)
    topics=[]
    for group,words in _RC24_TERMS.items():
        found=[w for w in words if re.search(r'(?<!\w)'+re.escape(w)+r'(?!\w)',norm)]
        if found:topics.append({'tema':group,'terminos_detectados':found,'cantidad':len(found)})
    topics.sort(key=lambda t:(-t['cantidad'],t['tema']))
    signals=[]
    for group,words in _RC24_SIGNALS.items():
        found=[w for w in words if re.search(r'(?<!\w)'+re.escape(w)+r'(?!\w)',norm)]
        if found:signals.append({'senal':group,'terminos_detectados':found})
    # No se infiere autoría, veracidad, amenaza personal ni probabilidad de conflicto.
    score=min(100, min(50,len(signals)*15)+min(30,len(topics)*6))
    level='Alta' if score>=65 else 'Media' if score>=35 else 'Baja'
    existing=[x for x in records_of('Narrativas') if str(x.get('Proyecto_ID') or x.get('project_id') or 'PRJ-SECHURA')==payload.project_id]
    counts=Counter()
    for r in existing:
        rt=_rc24_norm(' '.join(str(r.get(k) or '') for k in ('Tema','Descripcion')))
        for t in topics:
            if any(w in rt for w in _RC24_TERMS[t['tema']]):counts[t['tema']]+=1
    suggestions=[]
    if any(s['senal']=='Movilización anunciada' for s in signals):suggestions.append('Verificar convocatoria, fecha, lugar y fuente antes de actualizar el nivel de riesgo.')
    if any(s['senal']=='Demanda o reclamo' for s in signals):suggestions.append('Revisar si existe un compromiso o demanda vinculada en el registro territorial.')
    if any(s['senal']=='Información no corroborada' for s in signals):suggestions.append('Solicitar corroboración documental antes de difundir o escalar el contenido.')
    if topics:suggestions.append('Contrastar el hallazgo con fuentes, actores institucionales y evidencia de campo.')
    if not suggestions:suggestions.append('Registrar y verificar contexto; no hay términos suficientes para emitir una alerta temática.')
    return {'version':'2.4','project_id':payload.project_id,'source_url':payload.source_url,
      'analyzed_chars':len(content),'topics':topics,'signals':signals,'orientation':{'score':score,'level':level,'meaning':'Prioridad de revisión textual, no probabilidad de conflicto ni valoración de una persona.'},
      'project_comparison':[{'tema':t['tema'],'registros_relacionados_por_palabras':counts[t['tema']]} for t in topics],
      'suggested_actions':suggestions,'evidence':{'fragment':content[:500], 'sha256':hashlib.sha256(content.encode('utf-8')).hexdigest()},
      'method':'Coincidencia determinista de palabras clave normalizadas; sin inteligencia artificial generativa ni extracción automática.',
      'limitations':['No valida la autenticidad ni el contenido del enlace.','No permite afirmar causalidad, sentimientos, intenciones o riesgo individual.',
        'Confirmar con fuentes y revisión humana.','El texto enviado no se guarda por este endpoint.']}


# RC 2.5 — Semantic intelligence via opt-in local Ollama embedding service.
# No automatic URL fetching; no remote third-party APIs. Fail closed to explicit deterministic mode.
import math, urllib.request, urllib.error
from urllib.parse import urlsplit

_RC25_CONCEPTS = {
    'Ambiente y agua': 'Preocupaciones comunitarias por calidad de agua, contaminación ambiental, impacto ecológico y salud ambiental.',
    'Gobernanza y representación': 'Legitimidad de dirigencias comunales, decisiones de asamblea, elecciones y representación institucional.',
    'Territorio y uso de tierras': 'Acceso a predios, servidumbres, concesiones mineras, propiedad, límites y uso de tierras.',
    'Trabajo y economía local': 'Oportunidades de empleo, contratación local, proveedores, ingresos y beneficios económicos.',
    'Diálogo y compromisos': 'Solicitudes de reunión, acuerdos pendientes, incumplimientos, mesas de diálogo y negociación.',
    'Movilización social': 'Convocatorias públicas de marcha, protestas, paros y reuniones colectivas de protesta.',
    'Seguridad y emergencia': 'Accidentes operacionales, riesgos de seguridad física, emergencias y evacuación.'
}

class SemanticAnalysisIn(DigitalAnalysisIn):
    mode: str = 'automatic'  # automatic | semantic | rules


def _rc25_embedding(text: str):
    model=os.environ.get('MASCLI_OLLAMA_EMBED_MODEL','nomic-embed-text')
    req=urllib.request.Request('http://127.0.0.1:11434/api/embed',
        data=json.dumps({'model':model,'input':text[:12000]}).encode('utf-8'),
        headers={'Content-Type':'application/json'},method='POST')
    with urllib.request.urlopen(req, timeout=12) as r:
        obj=json.loads(r.read(1500000))
    vec=(obj.get('embeddings') or [None])[0]
    if not isinstance(vec,list) or len(vec)<8:raise ValueError('Modelo de embeddings sin resultado válido')
    return [float(v) for v in vec]

def _rc25_cos(a,b):
    if len(a)!=len(b):return 0.0
    na=math.sqrt(sum(x*x for x in a));nb=math.sqrt(sum(x*x for x in b))
    return sum(x*y for x,y in zip(a,b))/(na*nb) if na and nb else 0.0

@app.post('/system/intelligence/semantic-analyze')
def rc25_semantic_analyze(payload:SemanticAnalysisIn):
    if payload.mode not in {'automatic','semantic','rules'}:raise HTTPException(422,'Modo inválido')
    if payload.source_url:
        parsed=urlsplit(payload.source_url)
        if parsed.scheme not in ('http','https') or not parsed.netloc:raise HTTPException(422,'URL pública inválida')
    base=rc24_analyze_text(DigitalAnalysisIn(text=payload.text,project_id=payload.project_id,source_url=payload.source_url))
    base['version']='2.5'
    base['semantic']={'active':False,'method':'Reglas verificables; sin modelo semántico','matches':[], 'note':'Análisis de temas por reglas. No se ha interpretado semánticamente el texto.'}
    base['verification_status']='Pendiente de corroboración humana'
    base['source_retrieved']=False
    if payload.mode=='rules':return base
    try:
        content_vector=_rc25_embedding(payload.text.strip())
        scored=[]
        for label,description in _RC25_CONCEPTS.items():
            similarity=_rc25_cos(content_vector,_rc25_embedding(description))
            if similarity>=0.38:scored.append({'theme':label,'similarity':round(similarity,3),'reference':description})
        scored.sort(key=lambda x:-x['similarity'])
        base['semantic']={'active':True,'method':'Similitud coseno de embeddings del modelo local Ollama',
           'model':os.environ.get('MASCLI_OLLAMA_EMBED_MODEL','nomic-embed-text'),
           'matches':scored[:5], 'note':'Los valores son similitudes relativas, no probabilidades de conflicto ni pruebas de veracidad.'}
        base['method']='Análisis híbrido: reglas y similitud semántica local. Requiere corroboración humana.'
    except (OSError,ValueError,TimeoutError,urllib.error.URLError,KeyError) as exc:
        if payload.mode=='semantic':
            raise HTTPException(503,'Modelo local no disponible. Instale Ollama, descargue el modelo configurado o seleccione análisis por reglas.') from exc
        base['semantic']['note']='Ollama local no disponible; se aplicaron únicamente reglas. El análisis semántico NO se ejecutó.'
    return base


# RC 2.6 - Bandeja de alertas documentales/digitales separada del cálculo IRSA.
# No representa riesgo individual, no afirma veracidad y no modifica ponderaciones IRSA.
class ReviewCreateIn(SemanticAnalysisIn):
    source_type: str = 'Publicación digital'
    analyst_note: str = ''

class ReviewDecisionIn(BaseModel):
    status: str
    reviewer_note: str = ''

RC26_STATES = {'Pendiente de verificación','Corroborado','Descartado','En seguimiento'}

def rc26_store():
    c=conn()
    c.execute("""CREATE TABLE IF NOT EXISTS digital_alert_reviews (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, created_at TEXT NOT NULL,
        source_url TEXT, source_type TEXT, excerpt TEXT, sha256 TEXT,
        level TEXT, score INTEGER, method TEXT, themes_json TEXT, signals_json TEXT,
        suggestions_json TEXT, semantic_active INTEGER, status TEXT NOT NULL,
        analyst_note TEXT, reviewer_note TEXT, reviewed_at TEXT)""")
    c.commit()
    return c

@app.post('/system/intelligence/territorial-alerts')
def rc26_new_review(payload:ReviewCreateIn):
    if not payload.project_id.strip() or len(payload.project_id)>120:raise HTTPException(422,'Proyecto inválido')
    if payload.source_type not in {'Publicación digital','Documento','Reporte de campo'}:raise HTTPException(422,'Tipo de fuente inválido')
    analyzed=rc25_semantic_analyze(SemanticAnalysisIn(text=payload.text, project_id=payload.project_id,source_url=payload.source_url,mode=payload.mode))
    record_id='DIG-'+uuid.uuid4().hex[:12].upper()
    c=rc26_store()
    c.execute("INSERT INTO digital_alert_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",(
        record_id,payload.project_id,now(),payload.source_url,payload.source_type,
        payload.text.strip()[:500],analyzed['evidence']['sha256'],analyzed['orientation']['level'],
        analyzed['orientation']['score'],analyzed['method'],json.dumps(analyzed['topics'],ensure_ascii=False),
        json.dumps(analyzed['signals'],ensure_ascii=False),json.dumps(analyzed['suggested_actions'],ensure_ascii=False),
        int(analyzed['semantic']['active']),'Pendiente de verificación',payload.analyst_note[:2000],None,None))
    c.execute('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)',
              (now(),'InteligenciaDigital',record_id,'CREATE','Señal registrada; IRSA intacto'))
    c.commit();c.close()
    return {'id':record_id,'status':'Pendiente de verificación','analysis':analyzed,
            'irsa_modified':False,'notice':'La puntuación es prioridad de revisión, no riesgo social cuantificado.'}

@app.get('/system/intelligence/territorial-alerts')
def rc26_list_reviews(project_id:str=Query(...,min_length=1,max_length=120),limit:int=50):
    c=rc26_store()
    rows=c.execute('SELECT * FROM digital_alert_reviews WHERE project_id=? ORDER BY created_at DESC LIMIT ?',
                   (project_id,max(1,min(limit,200)))).fetchall();c.close()
    result=[]
    for r in rows:
        item=dict(r)
        for k in ('themes_json','signals_json','suggestions_json'):item[k[:-5]]=json.loads(item.pop(k))
        item['semantic_active']=bool(item['semantic_active']);result.append(item)
    return result

@app.patch('/system/intelligence/territorial-alerts/{review_id}')
def rc26_update_review(review_id:str,payload:ReviewDecisionIn):
    if payload.status not in RC26_STATES:raise HTTPException(422,'Estado inválido')
    if len(payload.reviewer_note)>2000:raise HTTPException(422,'Nota demasiado extensa')
    c=rc26_store();exists=c.execute('SELECT id FROM digital_alert_reviews WHERE id=?',(review_id,)).fetchone()
    if not exists:c.close();raise HTTPException(404,'Evaluación no encontrada')
    c.execute('UPDATE digital_alert_reviews SET status=?,reviewer_note=?,reviewed_at=? WHERE id=?',
              (payload.status,payload.reviewer_note,now(),review_id))
    c.execute('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)',
              (now(),'InteligenciaDigital',review_id,'REVIEW',payload.status))
    c.commit();c.close()
    return {'ok':True,'status':payload.status,'irsa_modified':False,
            'notice':'La validación NO cambia el IRSA. Registrar cambios de indicadores requiere metodología aprobada.'}

@app.get('/system/intelligence/territorial-summary')
def rc26_summary(project_id:str=Query(...,min_length=1,max_length=120)):
    items=rc26_list_reviews(project_id,limit=200)
    counts={state:sum(r['status']==state for r in items) for state in RC26_STATES}
    priority={level:sum(r['level']==level for r in items) for level in ('Alta','Media','Baja')}
    themes=Counter(t['tema'] for r in items for t in r['themes'])
    return {'version':'2.6','project_id':project_id,'total':len(items),'by_status':counts,
            'by_priority':priority,'themes':[{'name':k,'count':v} for k,v in themes.most_common(12)],
            'irsa_integration':'Sin modificación automática del IRSA; requiere validación metodológica',
            'caution':'Registros manuales, sin monitoreo permanente ni corroboración automática.'}


# RC 2.7 — Planes de respuesta y seguimiento; separados de IRSA.
from pydantic import Field
from datetime import date

RC27_STATUS={'Pendiente','En ejecución','Completada','Cancelada'}
class PreventiveActionIn(BaseModel):
    project_id:str=Field(min_length=1,max_length=120)
    alert_id:str=Field(min_length=1,max_length=80)
    title:str=Field(min_length=5,max_length=200)
    responsible:str=Field(min_length=2,max_length=150)
    due_date:date
    description:str=Field(default='',max_length=2000)
class ActionUpdateIn(BaseModel):
    status:str
    progress:int=Field(ge=0,le=100)
    note:str=Field(default='',max_length=2000)
    evidence_url:str=Field(default='',max_length=2000)

def rc27_store():
    c=rc26_store()
    c.execute("""CREATE TABLE IF NOT EXISTS preventive_actions (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, alert_id TEXT NOT NULL,
        title TEXT NOT NULL,responsible TEXT NOT NULL,due_date TEXT NOT NULL,
        description TEXT, status TEXT NOT NULL,progress INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""")
    c.execute("""CREATE TABLE IF NOT EXISTS preventive_action_log (
        id TEXT PRIMARY KEY,action_id TEXT NOT NULL,created_at TEXT NOT NULL,
        status TEXT NOT NULL,progress INTEGER NOT NULL,note TEXT,evidence_url TEXT)""")
    c.execute('CREATE INDEX IF NOT EXISTS idx_rc27_project ON preventive_actions(project_id)')
    c.execute('CREATE INDEX IF NOT EXISTS idx_rc27_log_action ON preventive_action_log(action_id)')
    c.commit()
    return c

def rc27_row(c,row):
    obj=dict(row)
    obj['history']=[dict(x) for x in c.execute('SELECT * FROM preventive_action_log WHERE action_id=? ORDER BY created_at DESC,id DESC',(obj['id'],)).fetchall()]
    return obj

@app.post('/system/prevention/actions')
def rc27_create_action(payload:PreventiveActionIn):
    c=rc27_store()
    alert=c.execute('SELECT project_id,status FROM digital_alert_reviews WHERE id=?',(payload.alert_id,)).fetchone()
    if not alert or alert['project_id']!=payload.project_id:
        c.close();raise HTTPException(404,'Alerta no pertenece al proyecto indicado')
    if alert['status'] not in ('Corroborado','En seguimiento'):
        c.close();raise HTTPException(409,'La alerta necesita verificación humana antes de crear un plan')
    aid='PREV-'+uuid.uuid4().hex[:12].upper();ts=now()
    c.execute('INSERT INTO preventive_actions VALUES(?,?,?,?,?,?,?,?,?,?,?)',(
        aid,payload.project_id,payload.alert_id,payload.title,payload.responsible,
        payload.due_date.isoformat(),payload.description,'Pendiente',0,ts,ts))
    c.execute('INSERT INTO preventive_action_log VALUES(?,?,?,?,?,?,?)',
              (uuid.uuid4().hex,aid,ts,'Pendiente',0,'Plan creado',None))
    c.execute('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)',
              (ts,'PrevencionTerritorial',aid,'CREATE',payload.alert_id))
    c.commit();row=rc27_row(c,c.execute('SELECT * FROM preventive_actions WHERE id=?',(aid,)).fetchone());c.close()
    return {'action':row,'irsa_modified':False}

@app.get('/system/prevention/actions')
def rc27_list_actions(project_id:str=Query(...,min_length=1,max_length=120)):
    c=rc27_store();rows=c.execute('SELECT * FROM preventive_actions WHERE project_id=? ORDER BY due_date ASC,created_at DESC',(project_id,)).fetchall()
    result=[rc27_row(c,row) for row in rows];c.close();return result

@app.patch('/system/prevention/actions/{action_id}')
def rc27_update_action(action_id:str,payload:ActionUpdateIn):
    if payload.status not in RC27_STATUS:raise HTTPException(422,'Estado no válido')
    if payload.status=='Completada' and payload.progress!=100:raise HTTPException(422,'Una acción completada debe indicar 100%')
    if payload.status=='Pendiente' and payload.progress>0:raise HTTPException(422,'Seleccione En ejecución cuando haya avance')
    if payload.evidence_url and not re.match(r'^https?://',payload.evidence_url,re.I):raise HTTPException(422,'Evidencia: use enlace http(s)')
    c=rc27_store();row=c.execute('SELECT * FROM preventive_actions WHERE id=?',(action_id,)).fetchone()
    if not row:c.close();raise HTTPException(404,'Acción no encontrada')
    if row['status']=='Cancelada' and payload.status!='Cancelada':c.close();raise HTTPException(409,'No puede reactivar una acción cancelada')
    if payload.status in ('Completada','Cancelada') and not payload.note.strip():
        c.close();raise HTTPException(422,'Justifique el cierre o cancelación')
    ts=now();c.execute('UPDATE preventive_actions SET status=?,progress=?,updated_at=? WHERE id=?',
      (payload.status,payload.progress,ts,action_id))
    c.execute('INSERT INTO preventive_action_log VALUES(?,?,?,?,?,?,?)',
      (uuid.uuid4().hex,action_id,ts,payload.status,payload.progress,payload.note,payload.evidence_url))
    c.execute('INSERT INTO audit(ts,module,record_id,action,detail) VALUES(?,?,?,?,?)',
      (ts,'PrevencionTerritorial',action_id,'UPDATE',payload.status+': '+payload.note[:200]))
    c.commit();out=rc27_row(c,c.execute('SELECT * FROM preventive_actions WHERE id=?',(action_id,)).fetchone());c.close()
    return {'action':out,'irsa_modified':False}

@app.get('/system/prevention/summary')
def rc27_summary(project_id:str=Query(...,min_length=1,max_length=120)):
    actions=rc27_list_actions(project_id);today=date.today().isoformat()
    active=[x for x in actions if x['status'] not in ('Completada','Cancelada')]
    overdue=[x for x in active if x['due_date']<today]
    completed=[x for x in actions if x['status']=='Completada']
    return {'project_id':project_id,'total':len(actions),'active':len(active),
            'overdue':len(overdue),'completed':len(completed),
            'completion_percent':round(len(completed)*100/len(actions),1) if actions else 0,
            'average_progress':round(sum(x['progress'] for x in actions)/len(actions),1) if actions else 0,
            'irsa_modified':False,
            'notice':'Métricas operativas de acciones; no equivalen a una disminución validada del riesgo social.'}


# RC 2.8 — Centro gerencial por proyecto. No recalcula IRSA ni certifica hechos.
from collections import Counter as RC28Counter
from fastapi.responses import Response
import csv, io

def rc28_report(project_id: str):
    c=rc27_store()
    alerts=[dict(r) for r in c.execute('SELECT id,created_at,source_url,source_type,level,score,status,reviewed_at FROM digital_alert_reviews WHERE project_id=? ORDER BY created_at DESC',(project_id,)).fetchall()]
    actions=[dict(r) for r in c.execute('SELECT id,alert_id,title,responsible,due_date,status,progress,updated_at FROM preventive_actions WHERE project_id=? ORDER BY due_date ASC',(project_id,)).fetchall()]
    # records is a generic store: filter using its serialized project metadata, not company-wide counts.
    commitments=[]
    for r in c.execute("SELECT record_id,payload FROM records WHERE module='Compromisos'").fetchall():
        try: obj=json.loads(r['payload'])
        except (ValueError,TypeError):continue
        scope=str(obj.get('Proyecto_ID') or 'PRJ-SECHURA')
        if scope != project_id:continue
        commitments.append({'id':r['record_id'],'responsible':str(obj.get('Responsable') or ''),
                            'status':str(obj.get('Estado') or ''),'due_date':str(obj.get('Fecha_Vencimiento') or obj.get('Fecha_Limite') or '')})
    c.close()
    day=date.today().isoformat()
    ongoing=[r for r in actions if r['status'] not in ('Completada','Cancelada')]
    late=[r for r in ongoing if r['due_date']<day]
    pending=[r for r in alerts if r['status']=='Pendiente de verificación']
    high=[r for r in alerts if r['level']=='Alta' and r['status']!='Descartado']
    critical=sorted(late,key=lambda r:r['due_date'])[:20]
    return {'version':'2.8','project_id':project_id,'generated_at':now(),
      'metrics':{'digital_alerts':len(alerts),'high_priority_alerts':len(high),'pending_review':len(pending),
        'total_actions':len(actions),'active_actions':len(ongoing),'overdue_actions':len(late),
        'completed_actions':sum(x['status']=='Completada' for x in actions),
        'completion_percent':round(100*sum(x['status']=='Completada' for x in actions)/len(actions),1) if actions else 0,
        'average_progress':round(sum(x['progress'] for x in actions)/len(actions),1) if actions else 0,
        'registered_commitments':len(commitments),
        'overdue_commitments_explicit':sum('vencid' in x['status'].lower() for x in commitments)},
      'alerts_by_level':dict(RC28Counter(x['level'] for x in alerts)),
      'actions_by_status':dict(RC28Counter(x['status'] for x in actions)),
      'actions_by_responsible':[{'name':k,'total':v,'overdue':sum(x['responsible']==k for x in late)} for k,v in RC28Counter(x['responsible'] for x in actions).most_common(30)],
      'critical_actions':critical,'recent_alerts':alerts[:15],
      'commitments':commitments[:100],
      'methodology':'Indicadores descriptivos de registros por proyecto; las prioridades digitales no son probabilidades de conflicto.',
      'limitations':['IRSA permanece independiente','Sin autenticación empresarial','Compromisos vencidos contados únicamente cuando el estado lo indica expresamente','No hay verificación automática de contenido en redes sociales']}

@app.get('/system/management/overview')
def rc28_overview(project_id:str=Query(...,min_length=1,max_length=120)):
    return rc28_report(project_id)

@app.get('/system/management/report.csv')
def rc28_export_csv(project_id:str=Query(...,min_length=1,max_length=120)):
    result=rc28_report(project_id); f=io.StringIO();w=csv.writer(f)
    w.writerow(['MASCLI RC 2.8','Resumen gerencial',result['project_id'],result['generated_at']]);w.writerow(['Indicador','Valor'])
    for k,v in result['metrics'].items():w.writerow([k,v])
    w.writerow([]);w.writerow(['Acciones críticas','Responsable','Plazo','Estado','Avance (%)'])
    for item in result['critical_actions']:w.writerow([item['title'],item['responsible'],item['due_date'],item['status'],item['progress']])
    w.writerow([]);w.writerow(['Nota metodológica',result['methodology']])
    content='\ufeff'+f.getvalue()
    return Response(content=content,media_type='text/csv; charset=utf-8',headers={'Content-Disposition':'attachment; filename="mascli_rc28_reporte_gerencial.csv"'})
