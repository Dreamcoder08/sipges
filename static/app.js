const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const pages=$$('.page');
const TITLES={dashboard:'Dashboard ejecutivo',gerencia:'Centro de control gerencial',eventos:'Eventos',actores:'Mapa y gestión de actores',directorio:'Directorio territorial',demandas:'Demandas y compromisos',narrativas:'Narrativas y señales digitales','inteligencia-redes':'Inteligencia de redes sociales',alertas:'Centro de alertas',mapa:'Mapa territorial MASCLI',situacion:'Análisis situacional',estrategia:'Inteligencia estratégica territorial',irsa:'IRSA-MASCLI',validacion:'Validación',fuentes:'Fuentes y evidencias',metodologia:'Metodología MASCLI',administracion:'Administración del sistema',audit:'Auditoría'};

function closeMenu(){document.body.classList.remove('menu-open')}
function toast(title,message='',type='success'){
  const region=$('#toastRegion'); if(!region)return;
  const el=document.createElement('div'); el.className='toast '+type;
  el.innerHTML=`<div class="toast-icon">${type==='error'?'!':'✓'}</div><div><strong>${esc(title)}</strong>${message?`<span>${esc(message)}</span>`:''}</div>`;
  region.appendChild(el); setTimeout(()=>el.remove(),4200);
}
function setConnection(ok){const el=$('#connectionStatus');if(!el)return;el.classList.toggle('offline',!ok);el.querySelector('span').textContent=ok?'Sincronizado':'Sin conexión'}
function goTo(page){
  $$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
  pages.forEach(p=>p.classList.toggle('active',p.id===page));
  if($('#pageTitle')) $('#pageTitle').textContent=TITLES[page]||'MASCLI';
  refresh(page); closeMenu(); window.scrollTo({top:0,behavior:'smooth'});
}
$$('.nav-item').forEach(a=>a.addEventListener('click',()=>goTo(a.dataset.page)));
$('#menuBtn')?.addEventListener('click',()=>document.body.classList.toggle('menu-open'));
$('#menuBackdrop')?.addEventListener('click',closeMenu);
document.addEventListener('click',e=>{if(document.body.classList.contains('menu-open')&&!e.target.closest('#sidebar')&&!e.target.closest('#menuBtn'))closeMenu()});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu()});

async function api(url,opt){
  try{
    const r=await fetch(url,opt);
    if(!r.ok) throw new Error(await r.text());
    setConnection(true); return r.json();
  }catch(err){setConnection(false);throw err}
}
function esc(x){return String(x??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
// Argumento JS seguro dentro de un atributo on*="…": literal JSON escapado para HTML.
// esc() solo no basta: el navegador decodifica &#39; antes de ejecutar el manejador.
function jsq(x){return esc(JSON.stringify(String(x??'')))}
function pick(o,keys){for(const k of keys)if(o[k]!=null&&o[k]!=='')return o[k];return ''}
function dim(x){const v=String(x||'');const c=v[0];return ['G','A','D','N','E','I'].includes(c)?`<span class="dim ${c}">${c}</span>`:esc(v)}
function levelClass(level){return 'level-'+String(level||'').replace(/\s+/g,'')}
function nowLabel(){return new Intl.DateTimeFormat('es-PE',{dateStyle:'medium',timeStyle:'short'}).format(new Date())}
function today(){return new Date().toISOString().slice(0,10)}
let DEFAULT_PROJECT_ID='PRJ-SECHURA';
let projectData=[],projectCoordinateData=null,activeProjectId=localStorage.getItem('mascli.activeProject')||DEFAULT_PROJECT_ID;
function activeProject(){return projectData.find(p=>p._id===activeProjectId)||projectData.find(p=>p._id===DEFAULT_PROJECT_ID)||{_id:DEFAULT_PROJECT_ID,Nombre:'Proyecto Sechura',Territorio:'Sechura, Piura',Estado:'Activo'}}
function projectMeta(){const p=activeProject();return {Proyecto_ID:p._id,Proyecto:p.Nombre||'Proyecto Sechura'}}
function recordProjectId(r){if(r?.Proyecto_ID)return String(r.Proyecto_ID);if(r?.Proyecto){const p=projectData.find(x=>normText(x.Nombre)===normText(r.Proyecto));return p?String(p._id):DEFAULT_PROJECT_ID}return DEFAULT_PROJECT_ID}
function forActiveProject(rows){return (rows||[]).filter(r=>recordProjectId(r)===activeProjectId)}
async function loadProjects(){const result=await Promise.all([api('/api/proyectos?limit=200'),api('/system/project-coordinates?project_id='+encodeURIComponent(DEFAULT_PROJECT_ID)).catch(()=>null)]);projectData=result[0];projectCoordinateData=result[1];if(!projectData.some(p=>p._id===activeProjectId&&p.Estado!=='Inactivo'))activeProjectId=DEFAULT_PROJECT_ID;const active=projectData.filter(p=>p.Estado!=='Inactivo'||p._id===activeProjectId);['projectSelector','mobileProjectSelector'].forEach(id=>{const select=$('#'+id);if(select){select.innerHTML=active.map(p=>{const geo=p._id===DEFAULT_PROJECT_ID&&projectCoordinateData?` · ${projectCoordinateData.summary.concession_count} concesiones`:'';return `<option value="${esc(p._id)}">${esc(p.Nombre+geo)}</option>`}).join('')+'<option value="__ADD__">＋ Agregar proyecto</option>';select.value=activeProjectId}});updateProjectContext()}
function updateProjectContext(){const p=activeProject();localStorage.setItem('mascli.activeProject',p._id);activeProjectId=p._id;if($('#sidebarProject'))$('#sidebarProject').textContent=(p.Nombre||'Proyecto').toUpperCase();if($('#activeProjectLabel'))$('#activeProjectLabel').textContent=p.Nombre||'Proyecto activo';if($('#srcProyecto'))$('#srcProyecto').value=p.Nombre||'';['projectSelector','mobileProjectSelector'].forEach(id=>{if($('#'+id))$('#'+id).value=p._id});document.title=`MASCLI | ${p.Nombre||'Proyecto'}`}
async function changeActiveProject(id){if(id==='__ADD__'){goTo('administracion');toggleProjectForm(true);if($('#projectSelector'))$('#projectSelector').value=activeProjectId;return}activeProjectId=id;updateProjectContext();toast('Proyecto activo',activeProject().Nombre);await refresh($('.page.active')?.id||'dashboard')}
function formatBytes(n){if(!Number.isFinite(Number(n)))return '—';if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(1)} MB`}
function previewFiles(inputId,targetId){const files=[...($('#'+inputId)?.files||[])],target=$('#'+targetId);if(!target)return;target.innerHTML=files.length?files.map(f=>`<span><b>▰</b>${esc(f.name)} <small>${formatBytes(f.size)}</small></span>`).join(''):'<span class="muted">Sin archivos seleccionados</span>'}
async function uploadFiles(files,module,recordId,meta={}){
  const results=[];
  for(const file of files){
    const body=new FormData();body.append('file',file);body.append('linked_module',module);body.append('linked_record_id',recordId);body.append('document_type',meta.document_type||'Reporte / evidencia');body.append('author',meta.author||'');body.append('verification',meta.verification||'E - No verificada');body.append('notes',meta.notes||'');
    results.push(await api('/system/uploads',{method:'POST',body}));
  }
  return results;
}

async function loadDashboard(){
  const [d,allAlerts,allEvents]=await Promise.all([api('/api/dashboard'),api('/api/alertas'),api('/api/eventos')]);
  const items=[['Eventos',d.eventos],['Actores analíticos',d.actores],['Demandas abiertas',d.demandas_abiertas],['Alertas activas',d.alertas_activas],['Directorio territorial',d.directorio],['Actores priorizados',d.priorizados]];
  $('#kpis').innerHTML=items.map(x=>`<div class="kpi"><span>${x[0]}</span><b>${x[1]}</b></div>`).join('');
  const lv=d.niveles||{};
  $('#risk').innerHTML=`<div class="risk"><div class="green">Verde<br><b>${lv.Verde||0}</b></div><div class="yellow">Amarillo<br><b>${lv.Amarillo||0}</b></div><div class="orange">Naranja<br><b>${lv.Naranja||0}</b></div><div class="red">Rojo<br><b>${lv.Rojo||0}</b></div></div>`;
  const alerts=forActiveProject(allAlerts).filter(a=>!['cerrada','cerrado','descartada','descartado'].includes(normText(a.Estado))),events=forActiveProject(allEvents),levels={Verde:0,Amarillo:0,Naranja:0,Rojo:0};alerts.forEach(a=>{const v=severityLevel(a.Nivel_Preliminar||a.Nivel);levels[v]=(levels[v]||0)+1});
  const maxLevel=Math.max(1,...Object.values(levels));if($('#alertsLevelChart'))$('#alertsLevelChart').innerHTML=Object.entries(levels).map(([label,value])=>`<div class="chart-row"><span>${label}</span><div class="chart-track"><i class="chart-${normText(label)}" style="width:${value/maxLevel*100}%"></i></div><b>${value}</b></div>`).join('')||'<div class="empty-state">Sin alertas</div>';
  const dims={G:0,A:0,D:0,N:0,E:0,I:0};events.forEach(e=>{const code=dimensionCode(e.Dimension_Principal,'');if(code&&dims[code]!==undefined)dims[code]++});const maxDim=Math.max(1,...Object.values(dims));if($('#eventsDimensionChart'))$('#eventsDimensionChart').innerHTML=Object.entries(dims).map(([code,value])=>`<div class="chart-row"><span class="dim ${code}">${code}</span><div class="chart-track"><i class="${code}" style="width:${value/maxDim*100}%"></i></div><b>${value}</b></div>`).join('');
  $('#lastRefresh').textContent='Actualizado: '+nowLabel();
}

const configs={
  eventos:{cols:[['Fecha',['Fecha']],['Territorio',['Territorio']],['Actor',['Actor_Principal']],['Tipo',['Tipo_Evento']],['Descripción',['Descripcion_Hecho']],['Dimensión',['Dimension_Principal']],['Verificación',['Nivel_Verificacion']]]},
  actores:{cols:[['Actor',['Nombre_Actor/Organizacion']],['Tipo',['Tipo_Actor']],['Territorio',['Territorio']],['Rol',['Rol/Relacion']],['Influencia',['Influencia']],['Posición',['Posicion_Proyecto']]]},
  demandas:{cols:[['Fecha',['Fecha_Registro']],['Actor / Grupo',['Actor/Grupo']],['Territorio',['Territorio']],['Tema',['Tema']],['Descripción',['Descripcion']],['Prioridad',['Prioridad']],['Estado',['Estado']]]},
  alertas:{cols:[['Fecha',['Fecha']],['Dimensión',['Dimension']],['Causa',['Causa']],['Nivel',['Nivel_Preliminar']],['Estado',['Estado']],['Acción sugerida',['Accion_Sugerida']]]},
  fuentes:{cols:[['ID',['ID_Fuente']],['Fecha',['Fecha_Documento']],['Archivo / Fuente',['Archivo_Fuente']],['Tipo',['Tipo_Fuente']],['Institución / Autor',['Institucion/Autor']],['Nivel',['Nivel_Base_Verificacion']]]}
};
async function loadTable(module,target,q=''){
  const el=document.getElementById(target); if(!el)return;
  el.innerHTML='<div class="loading-state"><span>Cargando registros…</span></div>';
  try{
    const rows=forActiveProject(await api('/api/'+module+(q?`?q=${encodeURIComponent(q)}`:'')));
    const conf=configs[module]; if(!conf)return;
    const styled=new Set(['Prioridad','Estado','Nivel','Verificación','Influencia','Posición']);
    let h='<table><thead><tr>'+conf.cols.map(c=>`<th>${c[0]}</th>`).join('')+'</tr></thead><tbody>';
    h+=rows.map(r=>'<tr>'+conf.cols.map(c=>{let v=pick(r,c[1]);if(c[0]==='Dimensión')return `<td>${dim(v)}</td>`;return `<td>${styled.has(c[0])&&v?`<span class="tag">${esc(v)}</span>`:esc(v)}</td>`}).join('')+'</tr>').join('')+'</tbody></table>';
    el.innerHTML=rows.length?h:`<div class="empty-state"><div><b>${q?'Sin coincidencias':'Aún no hay registros'}</b><span>${q?'Pruebe con otro término de búsqueda.':'Use el botón superior para crear el primer registro.'}</span></div></div>`;
  }catch(err){el.innerHTML='<div class="error-state"><div><b>No se pudieron cargar los registros</b><span>Verifique la conexión e intente nuevamente.</span></div></div>'}
}
async function loadAudit(){
  const rows=await api('/system/audit');
  $('#auditTable').innerHTML='<table><thead><tr><th>Fecha</th><th>Módulo</th><th>Registro</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${esc(r.ts)}</td><td>${esc(r.module)}</td><td>${esc(r.record_id)}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')+'</tbody></table>';
}
function openEventForm(){
  $('#eventForm').classList.toggle('hidden');
  if(!$('#eventForm').classList.contains('hidden')&&!$('#evFecha').value) $('#evFecha').value=new Date().toISOString().slice(0,10);
}
async function analyzeEvent(){
  const payload={Descripcion_Hecho:$('#evDesc').value,Tipo_Evento:$('#evTipo').value,Territorio:$('#evTerritorio').value,Actor_Principal:$('#evActor').value,Nivel_Verificacion:$('#evVer').value,Relevancia_Preliminar:$('#evRel').value};
  const a=await api('/system/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload})});
  const evidence=(a.evidence?.[a.dimension]||[]).slice(0,4).map(x=>x.signal).join(', ');
  $('#analysis').innerHTML=`<b>Resultado preliminar:</b> ${dim(a.dimension)} <b>${esc(a.dimension_label)}</b> · confianza ${esc(a.confidence)}% · <span class="level-pill ${levelClass(a.nivel_sugerido)}">${esc(a.nivel_sugerido)}</span>${evidence?`<br><span class="small">Señales: ${esc(evidence)}</span>`:''}<br><span class="small">${esc(a.nota)}</span>`;
  window.lastAnalysis=a;
}
async function saveEvent(){
  if(!$('#evDesc').value.trim()){toast('Falta la descripción','Ingrese el hecho territorial antes de guardar.','error');$('#evDesc').focus();return}
  if(!window.lastAnalysis)await analyzeEvent();
  const p={...projectMeta(),Fecha:$('#evFecha').value,Territorio:$('#evTerritorio').value,Actor_Principal:$('#evActor').value,Tipo_Evento:$('#evTipo').value,Descripcion_Hecho:$('#evDesc').value,Dimension_Principal:`${lastAnalysis.dimension} - ${lastAnalysis.dimension_label}`,Dimension_Secundaria:'',Nivel_Verificacion:$('#evVer').value,Fuente_ID:'','Evidencia/Resultado':'',Relevancia_Preliminar:$('#evRel').value,Estado_Validacion:'Preliminar',Analista:'Crystell Granda',Observaciones:'Registrado desde MASCLI Web Final RC 1.4'};
  const r=await api('/api/eventos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});
  const files=[...($('#evFiles')?.files||[])];
  let uploaded=0;
  try{if(files.length){await uploadFiles(files,'eventos',r.id,{document_type:'Evidencia de evento',author:'Crystell Granda',verification:$('#evVer').value,notes:$('#evDesc').value});uploaded=files.length}}
  catch(err){toast('Evento guardado, adjunto pendiente','El registro se creó, pero uno de los archivos no pudo cargarse. Revise tipo y tamaño.','error')}
  if(!files.length||uploaded)toast('Evento registrado',`Código ${r.id}${uploaded?` · ${uploaded} archivo(s) adjunto(s)`:''}`);
  window.lastAnalysis=null; $('#eventForm').classList.add('hidden'); $('#evDesc').value=''; if($('#evFiles'))$('#evFiles').value='';if($('#eventFileList'))$('#eventFileList').innerHTML=''; loadTable('eventos','eventTable'); loadDashboard();
}
async function quickCreate(module){
  const form=$(module==='actores'?'#actorForm':'#demandForm'); if(!form)return;
  form.classList.toggle('hidden');
  if(!form.classList.contains('hidden'))setTimeout(()=>form.querySelector('input')?.focus(),50);
}
async function saveActor(){
  const name=$('#acNombre').value.trim(); if(!name){toast('Falta el nombre','Identifique al actor u organización.','error');$('#acNombre').focus();return}
  const p={...projectMeta(),'Nombre_Actor/Organizacion':name,'Tipo_Actor':$('#acTipo').value,'Territorio':$('#acTerritorio').value.trim()||'Sechura','Rol/Relacion':$('#acRol').value.trim(),'Influencia':$('#acInfluencia').value,'Interes':'Por evaluar','Posicion_Proyecto':$('#acPosicion').value};
  const r=await api('/api/actores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});
  toast('Actor registrado',`Código ${r.id}`);$('#acNombre').value='';$('#acRol').value='';$('#actorForm').classList.add('hidden');loadTable('actores','actorTable');loadDashboard();
}
async function saveDemand(){
  const desc=$('#deDescripcion').value.trim(); if(!desc){toast('Falta la descripción','Describa la demanda antes de guardar.','error');$('#deDescripcion').focus();return}
  const p={...projectMeta(),'Fecha_Registro':new Date().toISOString().slice(0,10),'Actor/Grupo':$('#deActor').value.trim()||'Por definir','Territorio':$('#deTerritorio').value.trim()||'Sechura','Tema':$('#deTema').value.trim()||'Por clasificar','Descripcion':desc,'Prioridad':$('#dePrioridad').value,'Estado':'Nueva'};
  const r=await api('/api/demandas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});
  toast('Demanda registrada',`Código ${r.id}`);$('#deActor').value='';$('#deTema').value='';$('#deDescripcion').value='';$('#demandForm').classList.add('hidden');loadTable('demandas','demandTable');loadDashboard();
}

const DIMNAMES={G:'Gobernanza',A:'Actores',D:'Demandas',N:'Narrativas',E:'Ambiental',I:'Institucional'};
let irsaData=null;
function scoreClass(v){if(v===null||v===undefined)return 'score-na';if(v<25)return 'score-low';if(v<50)return 'score-mid';if(v<75)return 'score-high';return 'score-critical'}
function renderIndicators(){
  if(!irsaData||!$('#indicatorMatrix'))return;
  const f=$('#indicatorFilter')?.value||'ALL';
  const rows=irsaData.indicators.filter(x=>f==='ALL'||x.dimension===f);
  $('#indicatorMatrix').innerHTML='<table><thead><tr><th>Código</th><th>Indicador</th><th>Dim.</th><th>Puntaje</th><th>Confianza</th><th>Disponibilidad</th><th>Método / explicación</th></tr></thead><tbody>'+rows.map(x=>`<tr><td><b>${esc(x.code)}</b></td><td><b>${esc(x.name)}</b><br><span class="small muted">${esc(x.definition||'')}</span></td><td>${dim(x.dimension)}</td><td><span class="scorepill ${scoreClass(x.score)}">${x.score===null?'N/D':Number(x.score).toFixed(0)}</span></td><td><span class="conf">${esc(x.confidence)}</span></td><td>${esc(x.availability)}</td><td><b>${esc(x.method)}</b><br><span class="small muted">${esc(x.explanation)}</span></td></tr>`).join('')+'</tbody></table>';
}
function renderAvailability(){
  if(!irsaData||!$('#dataAvailability'))return;
  $('#dataAvailability').innerHTML='<div class="availability-grid">'+Object.entries(irsaData.availability||{}).map(([d,v])=>`<div class="av-card"><span class="dim ${d}">${d}</span><strong>${Number(v).toFixed(0)}%</strong><span class="small muted">${DIMNAMES[d]} · indicadores calculables</span><div class="bar"><i class="${d}" style="width:${v}%"></i></div></div>`).join('')+'</div>';
}
async function loadIRSA(){
  irsaData=await api('/system/irsa');
  if($('#dashIrsa')){
    $('#dashIrsa').textContent=irsaData.irsa.toFixed(1); $('#dashLevel').textContent=irsaData.level; $('#dashLevel').className='level-pill '+levelClass(irsaData.level);
    $('#dashDims').innerHTML=Object.entries(irsaData.scores).map(([d,v])=>`<div class="mini-dim"><span class="dim ${d}">${d}</span><em>${Number(v).toFixed(0)}</em></div>`).join('');
    const top=(irsaData.drivers||[]).slice(0,3);
    if($('#priorityDrivers'))$('#priorityDrivers').innerHTML=top.length?top.map(x=>`<div class="priority-item"><span class="dim ${x.dimension}">${x.dimension}</span><div class="priority-copy"><b>${esc(x.label)}</b><small>${esc(x.dimension_label||DIMNAMES[x.dimension])}</small></div><span class="priority-score">${Number(x.points).toFixed(0)}</span></div>`).join(''):'<div class="empty-state"><div><b>Sin factores críticos</b><span>No hay factores calculables en este momento.</span></div></div>';
  }
  if(!$('#irsaValue'))return;
  $('#irsaValue').textContent=irsaData.irsa.toFixed(1); $('#irsaLevel').textContent=irsaData.level; $('#irsaLevel').className='level-pill '+levelClass(irsaData.level);
  $('#dimensionCards').innerHTML=Object.entries(irsaData.scores).map(([d,v])=>`<div class="dim-card"><div class="letter ${d}">${d}</div><strong>${Number(v).toFixed(0)}</strong><div>${DIMNAMES[d]}</div><div class="bar"><i class="${d}" style="width:${Math.min(100,v)}%"></i></div></div>`).join('');
  $('#driversTable').innerHTML='<table><thead><tr><th>Dim.</th><th>Factor</th><th>Registro</th><th>Aporte</th></tr></thead><tbody>'+irsaData.drivers.map(x=>`<tr><td>${dim(x.dimension)}</td><td>${esc(x.label)}</td><td>${esc(x.id||'')}</td><td class="driver-points">+${x.points}</td></tr>`).join('')+'</tbody></table>';
  $('#weightForm').innerHTML=Object.entries(irsaData.weights).map(([d,v])=>`<label><span>${dim(d)} ${DIMNAMES[d]}</span><input id="w_${d}" type="number" min="0" max="1" step="0.01" value="${Number(v).toFixed(3)}"></label>`).join('');
  renderIndicators(); renderAvailability(); loadIRSAHistory();
}
async function saveWeights(){
  let weights={},sum=0;['G','A','D','N','E','I'].forEach(d=>{weights[d]=Number($('#w_'+d).value||0);sum+=weights[d]});
  if(Math.abs(sum-1)>0.02){alert('Los pesos deben sumar aproximadamente 1. Suma actual: '+sum.toFixed(3));return}
  await api('/system/irsa/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:{weights}})}); toast('Pesos guardados','El cambio quedó registrado en auditoría.'); loadIRSA(); loadDashboard();
}
async function saveSnapshot(){
  const note=prompt('Nota para este corte IRSA:','Corte de seguimiento'); if(note===null)return;
  const r=await api('/system/irsa/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:{note}})}); toast('Corte IRSA guardado',`${r.irsa} · ${r.level}`); loadIRSAHistory();
}
async function loadIRSAHistory(){
  if(!$('#irsaHistory'))return;
  const rows=await api('/system/irsa/history');
  $('#irsaHistory').innerHTML=rows.length?'<table><thead><tr><th>Fecha</th><th>IRSA</th><th>Nivel</th><th>G</th><th>A</th><th>D</th><th>N</th><th>E</th><th>I</th><th>Nota</th></tr></thead><tbody>'+rows.map(r=>`<tr><td>${esc(r.ts)}</td><td><b>${Number(r.irsa).toFixed(1)}</b></td><td><span class="level-pill ${levelClass(r.level)}">${esc(r.level)}</span></td>${['G','A','D','N','E','I'].map(d=>`<td>${Number(r.scores[d]||0).toFixed(0)}</td>`).join('')}<td>${esc(r.note||'')}</td></tr>`).join('')+'</tbody></table>':'<p class="muted small">Aún no se han guardado cortes IRSA.</p>';
}
async function loadModelStatus(){
  try{const s=await api('/system/model-status');if($('#modelStatus'))$('#modelStatus').innerHTML=`<b>${esc(s.version)}</b><br>Validación de contenido: <b>${esc(s.content_validation)}</b> · Validación funcional: <b>${esc(s.functional_validation||'Pendiente')}</b><br><span class="muted">${esc(s.release_rule)}</span>`}catch(e){}
}
async function loadValidation(){
  const data=await api('/system/validation-template');
  $('#validationIndicators').innerHTML='<table><thead><tr><th>Dim.</th><th>Código</th><th>Indicador</th><th>Definición</th><th>V de Aiken</th><th>Decisión</th></tr></thead><tbody>'+data.rows.map(x=>`<tr><td>${dim(x.dimension)}</td><td><b>${esc(x.code)}</b></td><td>${esc(x.name)}</td><td>${esc(x.definition)}</td><td><span class="tag warn">Pendiente</span></td><td>${esc(x.decision)}</td></tr>`).join('')+'</tbody></table>';
}

// --- Mapa territorial: representación referencial derivada de la Base Maestra ---
const LOCALITIES={
  sechura:{name:'Sechura',x:545,y:265,aliases:['sechura']},
  parachique:{name:'Parachique / La Bocana',x:365,y:162,aliases:['parachique','bocana']},
  bayovar:{name:'Puerto Rico / Bayóvar',x:300,y:300,aliases:['bayovar','bayóvar','puerto rico','mina de sal']},
  bahia:{name:'Bahía de Sechura',x:390,y:330,aliases:['bahia','bahía','pesca','maricultura']},
  vice:{name:'Vice',x:565,y:155,aliases:['vice']},
  illescas:{name:'Illescas',x:485,y:425,aliases:['illescas']},
  hierba:{name:'Hierba Blanca / desierto',x:705,y:320,aliases:['hierba blanca','desierto']},
  piura:{name:'Ámbito regional Piura',x:740,y:105,aliases:['piura']}
};
const LEVEL_COLORS={Rojo:'#d62f38',Naranja:'#f47c20',Amarillo:'#eebd24',Verde:'#26a269'};
let territorialData=[],selectedMapRecord=null,mapZoom=1;
function normText(v){return String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/�/g,'-')}
function displayText(v){return String(v??'').replace(/�/g,'–')}
function dimensionCode(v,fallback='D'){const c=String(v||'').trim()[0]?.toUpperCase();return ['G','A','D','N','E','I'].includes(c)?c:fallback}
function severityLevel(v){const n=normText(v);if(n.includes('critic')||n.includes('rojo'))return 'Rojo';if(n.includes('alta')||n.includes('naranja'))return 'Naranja';if(n.includes('media')||n.includes('amarillo'))return 'Amarillo';return 'Verde'}
function localityFor(text){const n=normText(text);for(const [key,l] of Object.entries(LOCALITIES)){if(key!=='sechura'&&l.aliases.some(a=>n.includes(normText(a))))return key}return n.includes('piura')&&!n.includes('sechura')?'piura':'sechura'}
function stableJitter(id,index){let h=0;for(const c of String(id))h=(h*31+c.charCodeAt(0))%997;const angle=(h%360)*Math.PI/180;const radius=9+(index%5)*6;return {dx:Math.cos(angle)*radius,dy:Math.sin(angle)*radius}}
function buildTerritorialRecords(eventos,demandas,alertas){
  const eventsById=Object.fromEntries(eventos.map(x=>[pick(x,['ID_Evento','_id']),x]));
  const demandsById=Object.fromEntries(demandas.map(x=>[pick(x,['ID_Demanda','_id']),x]));
  const mapped=[];
  alertas.forEach((a,i)=>{const origin=pick(a,['Evento/Registro_Origen']);const source=eventsById[origin]||demandsById[origin]||{};const territory=pick(source,['Territorio'])||'Sechura';mapped.push({id:pick(a,['ID_Alerta','_id'])||`AL-${i}`,type:'alerta',typeLabel:'Alerta',locality:localityFor([territory,a.Causa,source.Descripcion_Hecho,source.Descripcion].join(' ')),territory,dimension:dimensionCode(a.Dimension),level:severityLevel(a.Nivel_Preliminar),date:pick(a,['Fecha']),title:displayText(a.Causa)||'Alerta territorial',description:displayText(a.Accion_Sugerida),actor:displayText(pick(source,['Actor_Principal','Actor/Grupo']))||'Actor por verificar',source:displayText(a.Fuente_ID)||'Sin fuente vinculada',verification:displayText(a.Estado)});});
  eventos.forEach((e,i)=>mapped.push({id:pick(e,['ID_Evento','_id'])||`EV-${i}`,type:'evento',typeLabel:'Evento',locality:localityFor([e.Territorio,e.Descripcion_Hecho,e.Actor_Principal].join(' ')),territory:displayText(e.Territorio)||'Sechura',dimension:dimensionCode(e.Dimension_Principal,'A'),level:severityLevel(e.Relevancia_Preliminar),date:pick(e,['Fecha']),title:displayText(e.Tipo_Evento)||'Evento territorial',description:displayText(e.Descripcion_Hecho),actor:displayText(e.Actor_Principal)||'Actor por verificar',source:displayText(e.Fuente_ID)||'Sin fuente vinculada',verification:displayText(e.Nivel_Verificacion)}));
  demandas.forEach((d,i)=>mapped.push({id:pick(d,['ID_Demanda','_id'])||`DE-${i}`,type:'demanda',typeLabel:'Demanda',locality:localityFor([d.Territorio,d.Tema,d.Descripcion,d['Actor/Grupo']].join(' ')),territory:displayText(d.Territorio)||'Sechura',dimension:dimensionCode(d.Dimension,'D'),level:severityLevel(d.Prioridad),date:pick(d,['Fecha_Registro']),title:displayText(d.Tema)||'Demanda territorial',description:displayText(d.Descripcion),actor:displayText(d['Actor/Grupo'])||'Actor por verificar',source:displayText(d.Fuente_ID)||'Sin fuente vinculada',verification:displayText(d.Estado)}));
  const byLoc={};mapped.forEach(r=>{const i=byLoc[r.locality]||0;const j=stableJitter(r.id,i);byLoc[r.locality]=i+1;r.x=LOCALITIES[r.locality].x+j.dx;r.y=LOCALITIES[r.locality].y+j.dy});return mapped.sort((a,b)=>String(b.date).localeCompare(String(a.date)));
}
async function loadTerritorialMap(){
  let [eventos,demandas,alertas]=await Promise.all([api('/api/eventos'),api('/api/demandas'),api('/api/alertas')]);eventos=forActiveProject(eventos);demandas=forActiveProject(demandas);alertas=forActiveProject(alertas);
  territorialData=buildTerritorialRecords(eventos,demandas,alertas);
  const select=$('#mapLocalityFilter');if(select){const current=select.value;select.innerHTML='<option value="ALL">Todas</option>'+Object.entries(LOCALITIES).filter(([k])=>territorialData.some(r=>r.locality===k)).map(([k,l])=>`<option value="${k}">${esc(l.name)}</option>`).join('');select.value=[...select.options].some(o=>o.value===current)?current:'ALL'}
  if(!selectedMapRecord)selectedMapRecord=territorialData.find(x=>x.type==='alerta')||territorialData[0];renderTerritorialMap();renderProjectCoordinates();
}
function filteredTerritorialData(){const t=$('#mapTypeFilter')?.value||'ALL',d=$('#mapDimFilter')?.value||'ALL',l=$('#mapLevelFilter')?.value||'ALL',p=$('#mapLocalityFilter')?.value||'ALL';return territorialData.filter(x=>(t==='ALL'||x.type===t)&&(d==='ALL'||x.dimension===d)&&(l==='ALL'||x.level===l)&&(p==='ALL'||x.locality===p))}
function mapBaseSvg(){return `<defs><linearGradient id="sea" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#8fd3ee"/><stop offset="1" stop-color="#c9ebf5"/></linearGradient><pattern id="sand" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="3" cy="3" r="1" fill="#d7ccb2" opacity=".35"/></pattern></defs><rect width="900" height="540" fill="url(#sea)"/><g id="geoLayer" transform="translate(450 270) scale(${mapZoom}) translate(-450 -270)"><path class="map-land" fill="url(#sand)" d="M270,-10 C300,55 275,100 325,142 C350,166 332,205 365,235 C397,264 360,310 403,342 C435,365 438,405 488,430 C535,454 560,515 610,550 L910,550 L910,-10 Z"/><path class="map-water" d="M405 326 C448 300 495 315 525 348 C552 378 542 415 503 432 C466 446 425 423 404 390 C389 367 386 344 405 326Z"/><path class="map-district" d="M365 136 L520 222 L735 125 M375 238 L545 265 L716 320 M410 340 L565 155 M500 430 L545 265"/><path class="map-road" d="M292 298 C380 275 465 262 545 265 C625 268 700 235 790 198"/><path class="map-road" d="M545 265 C550 225 555 190 565 155"/><path class="map-road" d="M545 265 C515 325 495 377 485 425"/><text class="map-label" x="558" y="286">Sechura</text><text class="map-small-label" x="315" y="146">Parachique</text><text class="map-small-label" x="230" y="324">Puerto Rico · Bayóvar</text><text class="map-small-label" x="570" y="143">Vice</text><text class="map-small-label" x="480" y="455">Illescas</text><text class="map-small-label" x="662" y="345">Hierba Blanca</text><text class="map-small-label" x="420" y="382">Laguna de Sechura</text><text x="105" y="255" fill="#18749c" font-size="17" font-weight="800" letter-spacing="4" transform="rotate(-13 105 255)">OCÉANO PACÍFICO</text>`}
function renderTerritorialMap(){
  if(!$('#territorialMap'))return;const rows=filteredTerritorialData();if(!rows.includes(selectedMapRecord))selectedMapRecord=rows[0]||null;
  const markers=rows.map(r=>`<g class="marker ${selectedMapRecord?.id===r.id?'selected':''}" tabindex="0" role="button" aria-label="${esc(r.typeLabel+': '+r.title)}" transform="translate(${r.x.toFixed(1)} ${r.y.toFixed(1)})" onclick="selectMapRecord(${jsq(r.id)})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectMapRecord(${jsq(r.id)})}"><circle class="marker-ring" r="13"/><circle class="marker-core" r="13" fill="${LEVEL_COLORS[r.level]}"/><text class="marker-label" y="1">${r.dimension}</text></g>`).join('');
  $('#territorialMap').innerHTML=mapBaseSvg()+markers+'</g>';$('#mapResultCount').textContent=rows.length;
  const localities=new Set(rows.map(x=>x.locality)).size,critical=rows.filter(x=>x.level==='Rojo'||x.level==='Naranja').length,alerts=rows.filter(x=>x.type==='alerta').length,verified=rows.filter(x=>/^A|validada/i.test(x.verification)).length;
  $('#territorialKpis').innerHTML=[['⌖',localities,'Localidades visibles'],['!',critical,'Señales altas/críticas'],['●',alerts,'Alertas asociadas'],['✓',verified,'Registros verificados']].map(x=>`<div class="territorial-kpi"><i>${x[0]}</i><div><b>${x[1]}</b><span>${x[2]}</span></div></div>`).join('');
  renderMapDetail();$('#mapRecordList').innerHTML=rows.slice(0,9).map(r=>`<button class="map-record" onclick="selectMapRecord(${jsq(r.id)})"><span class="dim ${r.dimension}">${r.dimension}</span><span><b>${esc(r.title)}</b><small>${esc(LOCALITIES[r.locality].name)} · ${esc(r.date||'Sin fecha')} · ${esc(r.typeLabel)}</small></span><i class="level-dot" style="background:${LEVEL_COLORS[r.level]}"></i></button>`).join('')||'<div class="empty-state"><div><b>Sin puntos para estos filtros</b><span>Ajuste la dimensión, nivel o localidad.</span></div></div>';
}
function renderMapDetail(){const r=selectedMapRecord,el=$('#mapDetail');if(!el)return;if(!r){el.innerHTML='<div class="detail-empty"><div><strong>Sin selección</strong><span>Seleccione un punto del mapa.</span></div></div>';return}el.innerHTML=`<div class="detail-header"><div class="card-label">PUNTO SELECCIONADO</div><h3>${esc(LOCALITIES[r.locality].name)}</h3><small>${esc(r.territory)}</small></div><div class="detail-body"><div class="detail-badges"><span class="dim ${r.dimension}">${r.dimension}</span><span class="level-pill ${levelClass(r.level)}">${esc(r.level)}</span><span class="tag">${esc(r.typeLabel)}</span></div><div class="detail-row"><span>Registro</span><b>${esc(r.id)} · ${esc(r.date||'Sin fecha')}</b></div><div class="detail-row"><span>Señal</span><b>${esc(r.title)}</b></div><div class="detail-row"><span>Actor / grupo</span><b>${esc(r.actor)}</b></div><div class="detail-row"><span>Descripción / acción</span><b>${esc(r.description||'Sin detalle disponible')}</b></div><div class="detail-row"><span>Trazabilidad</span><b>${esc(r.source)} · ${esc(r.verification||'Por verificar')}</b></div><div class="data-caveat">Ubicación referencial asignada por territorio o palabras clave del registro. Requiere validación de coordenadas en campo.</div></div>`}
function selectMapRecord(id){selectedMapRecord=territorialData.find(x=>String(x.id)===String(id))||null;renderTerritorialMap()}
function zoomTerritorialMap(delta,reset=false){mapZoom=reset?1:Math.max(.82,Math.min(1.48,mapZoom+delta));renderTerritorialMap()}
function resetTerritorialFilters(){['mapTypeFilter','mapDimFilter','mapLevelFilter','mapLocalityFilter'].forEach(id=>{const el=$('#'+id);if(el)el.value='ALL'});mapZoom=1;renderTerritorialMap()}

// --- Coordenadas oficiales de referencia: concesiones IEPA Sechura ---
let selectedConcessionCode=null;
const CONCESSION_COLORS=['#ef6c36','#f1c232','#58a96b','#3d96c6','#8b68bd'];
function coord(value,digits=6){return Number(value).toLocaleString('es-PE',{minimumFractionDigits:digits,maximumFractionDigits:digits})}
function hectares(value,digits=0){return Number(value).toLocaleString('es-PE',{minimumFractionDigits:digits,maximumFractionDigits:digits})+' ha'}
function concessionProjection(){const [minLon,minLat,maxLon,maxLat]=projectCoordinateData.bbox,pad=38,width=700,height=430,innerW=width-pad*2,innerH=height-pad*2;return {minLon,minLat,maxLon,maxLat,pad,width,height,x:lon=>pad+(lon-minLon)/(maxLon-minLon)*innerW,y:lat=>height-pad-(lat-minLat)/(maxLat-minLat)*innerH}}
function renderProjectCoordinates(){
  const section=$('#projectCoordinatesSection');if(!section)return;
  const visible=activeProjectId===DEFAULT_PROJECT_ID&&projectCoordinateData?.concessions?.length;section.classList.toggle('hidden',!visible);if(!visible)return;
  if(!projectCoordinateData.concessions.some(x=>x.code===selectedConcessionCode))selectedConcessionCode=projectCoordinateData.concessions[0].code;
  const p=concessionProjection(),xTicks=Array.from({length:5},(_,i)=>p.minLon+(p.maxLon-p.minLon)*i/4),yTicks=Array.from({length:5},(_,i)=>p.minLat+(p.maxLat-p.minLat)*i/4);
  const grid=xTicks.map(v=>`<g><line x1="${p.x(v)}" y1="${p.pad}" x2="${p.x(v)}" y2="${p.height-p.pad}"/><text x="${p.x(v)}" y="${p.height-11}">${coord(v,4)}°</text></g>`).join('')+yTicks.map(v=>`<g><line x1="${p.pad}" y1="${p.y(v)}" x2="${p.width-p.pad}" y2="${p.y(v)}"/><text x="7" y="${p.y(v)+4}" text-anchor="start">${coord(v,4)}°</text></g>`).join('');
  const polygons=projectCoordinateData.concessions.map((c,i)=>{const ring=c.geometry.coordinates[0],points=ring.map(([lon,lat])=>`${p.x(lon).toFixed(1)},${p.y(lat).toFixed(1)}`).join(' '),center=[p.x(c.centroid.longitude),p.y(c.centroid.latitude)],selected=c.code===selectedConcessionCode;return `<g class="concession-shape ${selected?'selected':''}" role="button" tabindex="0" aria-label="Seleccionar ${esc(c.name)}" onclick="selectConcession(${jsq(c.code)})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectConcession(${jsq(c.code)})}"><polygon points="${points}" fill="${CONCESSION_COLORS[i%CONCESSION_COLORS.length]}"/><text x="${center[0].toFixed(1)}" y="${center[1].toFixed(1)}">${esc(c.name.replace('BAYOVAR ',''))}</text></g>`}).join('');
  $('#projectCoordinateMap').innerHTML=`<rect width="700" height="430" class="coordinate-bg"/><g class="coordinate-grid">${grid}</g>${polygons}<g class="north-arrow" transform="translate(650 38)"><path d="M0 24 L10 0 L20 24 L10 18 Z"/><text x="10" y="-6">N</text></g>`;
  $('#concessionTable').innerHTML=`<table><thead><tr><th>Concesión</th><th>Código único</th><th>Área nominal</th><th>Área GIS</th><th>Centroide WGS84</th></tr></thead><tbody>${projectCoordinateData.concessions.map(c=>`<tr class="click-row ${c.code===selectedConcessionCode?'selected-row':''}" onclick="selectConcession(${jsq(c.code)})"><td><b>${esc(c.name)}</b></td><td>${esc(c.code)}</td><td>${hectares(c.nominal_area_ha)}</td><td>${hectares(c.gis_area_ha,2)}</td><td><code>${coord(c.centroid.latitude)}, ${coord(c.centroid.longitude)}</code></td></tr>`).join('')}</tbody></table>`;
  renderConcessionDetail();
}
function renderConcessionDetail(){const c=projectCoordinateData?.concessions?.find(x=>x.code===selectedConcessionCode),el=$('#concessionDetail');if(!c||!el)return;const vertices=c.geometry.coordinates[0].slice(0,-1);el.innerHTML=`<div class="detail-header"><div class="card-label">CONCESIÓN SELECCIONADA</div><h3>${esc(c.name)}</h3><small>${esc(c.code)} · ${esc(c.substance)}</small></div><div class="concession-detail-body"><div class="coordinate-summary"><span><b>${hectares(c.nominal_area_ha)}</b>Área nominal</span><span><b>${hectares(c.gis_area_ha,2)}</b>Área GIS</span></div><div class="detail-row"><span>Centroide referencial (latitud, longitud)</span><b><code>${coord(c.centroid.latitude)}, ${coord(c.centroid.longitude)}</code></b></div><div class="detail-row"><span>Titular registrado en la consulta</span><b>${esc(c.holder)}</b></div><div class="detail-row vertex-section"><span>Vértices WGS84 · EPSG:4326</span><ol>${vertices.map(([lon,lat],i)=>`<li><i>V${i+1}</i><code>${coord(lat)}, ${coord(lon)}</code></li>`).join('')}</ol></div><div class="data-caveat">El centroide se calculó para facilitar la lectura. Los vértices proceden del polígono GeoCatMin consultado y se expresan como latitud, longitud.</div></div>`}
function selectConcession(code){selectedConcessionCode=code;renderProjectCoordinates()}

// --- Red de actores: vínculos exploratorios derivados, con foco y detalle ---
let actorNetworkData={actors:[],events:[],demands:[]},selectedActorId=null;
const ACTOR_COLORS={comunal:'#7a2db5','organizacion':'#d23f77','institucional':'#147bb7','autoridad':'#e06a18','productivo':'#2d9b67','academico':'#6b7b8c','otro':'#708090'};
function typeKey(v){const n=normText(v);return Object.keys(ACTOR_COLORS).find(k=>n.includes(k))||'otro'}
function actorId(a,i=0){return pick(a,['ID_Actor','_id'])||`ACT-${i}`}
function actorName(a){return displayText(pick(a,['Nombre_Actor/Organizacion']))||'Actor sin nombre'}
function actorTokens(a){const stop=new Set(['comunidad','campesina','sechura','martin','organizacion','organizaciones','provincial','local','actor']);return normText(actorName(a)).split(/[^a-z0-9]+/).filter(x=>x.length>4&&!stop.has(x)).slice(0,4)}
function recordSetFor(a){const toks=actorTokens(a);const rows=[...actorNetworkData.events.map((r,i)=>['E'+i,[r.Actor_Principal,r.Descripcion_Hecho,r.Observaciones].join(' ')]),...actorNetworkData.demands.map((r,i)=>['D'+i,[r['Actor/Grupo'],r.Tema,r.Descripcion].join(' ')])];return new Set(rows.filter(([,text])=>toks.some(t=>normText(text).includes(t))).map(([id])=>id))}
function relationBetween(a,b){const sa=recordSetFor(a),sb=recordSetFor(b);const common=[...sa].filter(x=>sb.has(x));if(common.length)return {type:'direct',label:'Coincidencia en registros',strength:3,count:common.length};const ta=normText(a.Territorio),tb=normText(b.Territorio);if(ta&&tb&&(ta.includes(tb)||tb.includes(ta)||ta.split('/').some(x=>x.length>4&&tb.includes(x))))return {type:'territory',label:'Ámbito compartido',strength:2,count:0};if(typeKey(a.Tipo_Actor)===typeKey(b.Tipo_Actor))return {type:'agenda',label:'Agenda afín',strength:1,count:0};return {type:'agenda',label:'Contexto territorial MASCLI',strength:.5,count:0}}
function influenceRank(v){const n=normText(v);return n.includes('alta')?3:n.includes('media')?2:1}
async function loadActorNetwork(){
  let [actors,events,demands]=await Promise.all([api('/api/actores'),api('/api/eventos'),api('/api/demandas')]);actors=forActiveProject(actors);events=forActiveProject(events);demands=forActiveProject(demands);actorNetworkData={actors,events,demands};
  if(!selectedActorId&&actors.length)selectedActorId=actorId(actors[0],0);
  const actorSelect=$('#networkActorSelect'),typeSelect=$('#networkTypeFilter');if(actorSelect){actorSelect.innerHTML=actors.map((a,i)=>`<option value="${esc(actorId(a,i))}">${esc(actorName(a))}</option>`).join('');actorSelect.value=selectedActorId}
  if(typeSelect){const current=typeSelect.value||'ALL';const types=[...new Set(actors.map(a=>typeKey(a.Tipo_Actor)))];typeSelect.innerHTML='<option value="ALL">Todos</option>'+types.map(t=>`<option value="${t}">${esc(t[0].toUpperCase()+t.slice(1))}</option>`).join('');typeSelect.value=[...typeSelect.options].some(o=>o.value===current)?current:'ALL'}
  renderActorNetwork();
}
function shortActorLabel(name){const clean=displayText(name).replace(/\([^)]*\)/g,'').trim();return clean.length>27?clean.slice(0,25)+'…':clean}
function actorInitials(name){return displayText(name).split(/[\s/]+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()}
function renderActorNetwork(){
  const svg=$('#actorNetwork');if(!svg||!actorNetworkData.actors.length)return;const actors=actorNetworkData.actors;let focus=actors.find((a,i)=>actorId(a,i)===selectedActorId)||actors[0];selectedActorId=actorId(focus);
  const filter=$('#networkTypeFilter')?.value||'ALL';let candidates=actors.filter(a=>actorId(a)!==selectedActorId&&(filter==='ALL'||typeKey(a.Tipo_Actor)===filter)).map(a=>({a,rel:relationBetween(focus,a)})).sort((x,y)=>y.rel.strength-x.rel.strength||influenceRank(y.a.Influencia)-influenceRank(x.a.Influencia)).slice(0,11);
  const cx=410,cy=225,rx=310,ry=175;const nodes=[{a:focus,x:cx,y:cy,focus:true},...candidates.map((x,i)=>({a:x.a,rel:x.rel,x:cx+Math.cos((i/candidates.length)*Math.PI*2-Math.PI/2)*rx,y:cy+Math.sin((i/candidates.length)*Math.PI*2-Math.PI/2)*ry,focus:false}))];
  const edges=nodes.slice(1).map(n=>`<line class="network-edge ${n.rel.type}" x1="${cx}" y1="${cy}" x2="${n.x.toFixed(1)}" y2="${n.y.toFixed(1)}"><title>${esc(n.rel.label)}</title></line>`).join('');
  const nodeSvg=nodes.map(n=>{const id=actorId(n.a),name=actorName(n.a),color=ACTOR_COLORS[typeKey(n.a.Tipo_Actor)];return `<g class="network-node ${n.focus?'selected':''}" transform="translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})" tabindex="0" role="button" aria-label="Enfocar ${esc(name)}" onclick="selectNetworkActor(${jsq(id)})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectNetworkActor(${jsq(id)})}"><circle r="${n.focus?38:27}" fill="${color}"/><text class="initials" y="1">${esc(actorInitials(name))}</text><text y="${n.focus?57:45}">${esc(shortActorLabel(name))}</text></g>`}).join('');svg.innerHTML=`<defs><pattern id="networkGrid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="#dbe7ec" stroke-width=".7"/></pattern></defs><rect width="820" height="470" fill="url(#networkGrid)"/>${edges}${nodeSvg}`;
  const direct=candidates.filter(x=>x.rel.type==='direct').length,territory=candidates.filter(x=>x.rel.type==='territory').length;$('#networkStats').innerHTML=[['Actores',actors.length],['Entorno visible',nodes.length],['Coincidencias',direct],['Ámbitos compartidos',territory]].map(x=>`<div class="network-stat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');renderNetworkDetail(focus,candidates);
}
function renderNetworkDetail(actor,candidates){const el=$('#networkDetail');if(!el)return;const strongest=candidates.slice(0,3);el.className='visual-detail network-detail';el.innerHTML=`<div class="detail-header"><div class="card-label">ACTOR FOCAL</div><h3>${esc(shortActorLabel(actorName(actor)))}</h3><small>${esc(displayText(actor.Tipo_Actor)||'Tipo por verificar')}</small></div><div class="detail-body"><div class="actor-avatar-lg" style="background:${ACTOR_COLORS[typeKey(actor.Tipo_Actor)]}">${esc(actorInitials(actorName(actor)))}</div><div class="detail-row"><span>Territorio</span><b>${esc(displayText(actor.Territorio)||'Por verificar')}</b></div><div class="detail-row"><span>Influencia / interés</span><b>${esc(displayText(actor.Influencia)||'Por evaluar')} · ${esc(displayText(actor.Interes)||'Por evaluar')}</b></div><div class="detail-row"><span>Posición registrada</span><b>${esc(displayText(actor.Posicion_Proyecto)||'No determinada')}</b></div><div class="detail-row"><span>Rol / relación</span><b>${esc(displayText(actor['Rol/Relacion'])||'Sin detalle')}</b></div><div class="detail-row"><span>Conexiones destacadas</span><b>${strongest.map(x=>`${esc(shortActorLabel(actorName(x.a)))} · ${esc(x.rel.label)}`).join('<br>')||'Sin conexiones visibles'}</b></div><div class="data-caveat">Las aristas se calculan por coincidencia textual, ámbito o tipo de actor. No implican alianza, conflicto ni representación formal.</div></div>`}
function selectNetworkActor(id){selectedActorId=id;if($('#networkActorSelect'))$('#networkActorSelect').value=id;renderActorNetwork()}
function resetActorNetwork(){const first=actorNetworkData.actors[0];selectedActorId=first?actorId(first):null;if($('#networkTypeFilter'))$('#networkTypeFilter').value='ALL';if($('#networkActorSelect'))$('#networkActorSelect').value=selectedActorId;renderActorNetwork()}

// --- Directorio territorial de autoridades y líderes ---
let directoryData=[],selectedDirectory=null;
function fieldLike(row,...needles){for(const [key,value] of Object.entries(row||{})){const nk=normText(key).replace(/[^a-z0-9]+/g,' ');if(needles.every(n=>nk.includes(normText(n))))return displayText(value)}return ''}
function dirValue(r,key){const map={name:['nombre','actualizado'],position:['cargo'],institution:['institucion'],territory:['lugar'],section:['secci'],type:['tipo','actor'],priority:['prioridad'],status:['estado','verific'],source:['fuente'],notes:['observaciones'],phone:['telefono']};if(key==='name')return displayText(r.Nombre||r['Nombre actualizado 2026']||fieldLike(r,...map.name));if(key==='position')return displayText(r.Cargo||fieldLike(r,...map.position));if(key==='institution')return displayText(r.Institucion||r['Institución / Organización']||fieldLike(r,...map.institution));if(key==='territory')return displayText(r.Territorio||r['Lugar / ámbito']||fieldLike(r,...map.territory)||fieldLike(r,...map.section));if(key==='type')return displayText(r.Tipo_Actor||r['Tipo de actor MASCLI']||fieldLike(r,...map.type));if(key==='priority')return displayText(r.Prioridad||r['Prioridad MASCLI propuesta']||fieldLike(r,...map.priority));if(key==='status')return displayText(r.Estado_Verificacion||r['Estado de verificación']||fieldLike(r,...map.status));if(key==='phone')return displayText(r.Telefono||r.Celular||r['Número de contacto']||r['Número de celular']||r['Telefono / celular']||fieldLike(r,'telefono')||fieldLike(r,'celular'));if(key==='source')return displayText(r.Fuente_ID||fieldLike(r,...map.source));return displayText(r.Observaciones||fieldLike(r,...map.notes))}
async function loadDirectory(){directoryData=forActiveProject(await api('/api/directorio?limit=300'));const territories=[...new Set(directoryData.map(r=>dirValue(r,'territory')).filter(Boolean))].sort(),types=[...new Set(directoryData.map(r=>dirValue(r,'type')).filter(Boolean))].sort();$('#dirTerritoryFilter').innerHTML='<option value="ALL">Todos los territorios</option>'+territories.map(x=>`<option>${esc(x)}</option>`).join('');$('#dirTypeFilter').innerHTML='<option value="ALL">Todos los tipos</option>'+types.map(x=>`<option>${esc(x)}</option>`).join('');renderDirectory()}
function renderDirectory(){if(!$('#directoryTable'))return;const q=normText($('#dirSearch')?.value),territory=$('#dirTerritoryFilter')?.value||'ALL',type=$('#dirTypeFilter')?.value||'ALL',priority=$('#dirPriorityFilter')?.value||'ALL';const rows=directoryData.filter(r=>(!q||normText(JSON.stringify(r)).includes(q))&&(territory==='ALL'||dirValue(r,'territory')===territory)&&(type==='ALL'||dirValue(r,'type')===type)&&(priority==='ALL'||dirValue(r,'priority')===priority));const authorities=directoryData.filter(r=>/autoridad|institucional|gobernador|municipal/i.test(dirValue(r,'type')+' '+dirValue(r,'position'))).length,verified=directoryData.filter(r=>!normText(dirValue(r,'status')).includes('por verificar')).length;$('#directoryStats').innerHTML=[['Contactos',directoryData.length],['Autoridades / institucionales',authorities],['Fichas con referencia',directoryData.filter(r=>dirValue(r,'source')).length],['Revisión registrada',verified]].map(x=>`<div class="territorial-kpi"><i>⌖</i><div><b>${x[1]}</b><span>${x[0]}</span></div></div>`).join('');$('#directoryTable').innerHTML=rows.length?'<table><thead><tr><th>Nombre</th><th>Cargo</th><th>Institución</th><th>Territorio</th><th>Teléfono</th><th>Prioridad</th><th></th></tr></thead><tbody>'+rows.map(r=>`<tr class="click-row" onclick="selectDirectory(${jsq(r._id)})"><td><b>${esc(dirValue(r,'name')||'Por confirmar')}</b></td><td>${esc(dirValue(r,'position'))}</td><td>${esc(dirValue(r,'institution'))}</td><td>${esc(dirValue(r,'territory'))}</td><td>${esc(dirValue(r,'phone')||'Sin registrar')}</td><td><span class="tag">${esc(dirValue(r,'priority')||'Por evaluar')}</span></td><td><button class="row-action" onclick="event.stopPropagation();editDirectory(${jsq(r._id)})" aria-label="Editar ficha">✎</button></td></tr>`).join('')+'</tbody></table>':'<div class="empty-state"><div><b>Sin coincidencias</b><span>Ajuste los filtros del directorio.</span></div></div>';if(!selectedDirectory||!rows.some(r=>r._id===selectedDirectory._id))selectedDirectory=rows[0]||null;renderDirectoryDetail()}
function selectDirectory(id){selectedDirectory=directoryData.find(r=>r._id===id)||null;renderDirectoryDetail()}
function renderDirectoryDetail(){const r=selectedDirectory,el=$('#directoryDetail');if(!el)return;if(!r){el.innerHTML='<div class="detail-empty"><div><strong>Seleccione una ficha</strong><span>Verá su información y estado de verificación.</span></div></div>';return}el.innerHTML=`<div class="detail-header"><div class="card-label">FICHA TERRITORIAL</div><h3>${esc(dirValue(r,'name')||'Nombre por confirmar')}</h3><small>${esc(dirValue(r,'position')||'Cargo por confirmar')}</small></div><div class="detail-body"><div class="detail-row"><span>Institución / organización</span><b>${esc(dirValue(r,'institution')||'Por confirmar')}</b></div><div class="detail-row"><span>Territorio</span><b>${esc(dirValue(r,'territory')||'Por confirmar')}</b></div><div class="detail-row"><span>Teléfono / celular</span><b>${esc(dirValue(r,'phone')||'Sin registrar')}</b></div><div class="detail-row"><span>Tipo / prioridad</span><b>${esc(dirValue(r,'type')||'Por evaluar')} · ${esc(dirValue(r,'priority')||'Por evaluar')}</b></div><div class="detail-row"><span>Verificación</span><b>${esc(dirValue(r,'status')||'Por verificar')}</b></div><div class="detail-row"><span>Fuente</span><b>${esc(dirValue(r,'source')||'Sin referencia')}</b></div><div class="detail-row"><span>Observaciones</span><b>${esc(dirValue(r,'notes')||'Sin observaciones')}</b></div><div class="actions"><button class="secondary" onclick="editDirectory(${jsq(r._id)})">Editar ficha</button></div></div>`}
function toggleDirectoryForm(show){const el=$('#directoryForm');if(!el)return;const display=show===undefined?el.classList.contains('hidden'):show;el.classList.toggle('hidden',!display);if(display&&!$('#dirId').value)setTimeout(()=>$('#dirNombre')?.focus(),20);if(!display)clearDirectoryForm()}
function clearDirectoryForm(){['dirId','dirNombre','dirCargo','dirInstitucion','dirObs','dirFuente'].forEach(id=>{if($('#'+id))$('#'+id).value=''});if($('#dirTerritorio'))$('#dirTerritorio').value='Sechura';$('#directoryFormMode').textContent='NUEVO REGISTRO'}
function editDirectory(id){const r=directoryData.find(x=>x._id===id);if(!r)return;$('#dirId').value=id;$('#dirNombre').value=dirValue(r,'name');$('#dirCargo').value=dirValue(r,'position');$('#dirTelefono').value=dirValue(r,'phone');$('#dirInstitucion').value=dirValue(r,'institution');$('#dirTerritorio').value=dirValue(r,'territory');$('#dirTipo').value=dirValue(r,'type')||'Otro / por verificar';if(![...$('#dirTipo').options].some(o=>o.value===$('#dirTipo').value))$('#dirTipo').value='Otro / por verificar';$('#dirPrioridad').value=dirValue(r,'priority')||'Media';$('#dirEstado').value=dirValue(r,'status')||'Por verificar';if(![...$('#dirEstado').options].some(o=>o.value===$('#dirEstado').value))$('#dirEstado').value='Actualizado por fuente';$('#dirFuente').value=dirValue(r,'source');$('#dirObs').value=dirValue(r,'notes');$('#directoryFormMode').textContent='EDITAR REGISTRO';toggleDirectoryForm(true)}
async function saveDirectoryEntry(){const name=$('#dirNombre').value.trim();if(!name){toast('Falta el nombre','Identifique a la autoridad o líder.','error');return}const id=$('#dirId').value,base=id?(directoryData.find(x=>x._id===id)||{}):{};const p={...base,...projectMeta(),Nombre:name,Cargo:$('#dirCargo').value.trim(),Telefono:$('#dirTelefono').value.trim(),Institucion:$('#dirInstitucion').value.trim(),Territorio:$('#dirTerritorio').value.trim(),Tipo_Actor:$('#dirTipo').value,Prioridad:$('#dirPrioridad').value,Estado_Verificacion:$('#dirEstado').value,Fuente_ID:$('#dirFuente').value.trim(),Observaciones:$('#dirObs').value.trim()};delete p._id;delete p._updated_at;await api(id?`/api/directorio/${encodeURIComponent(id)}`:'/api/directorio',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});toast(id?'Ficha actualizada':'Contacto agregado','El directorio quedó actualizado.');toggleDirectoryForm(false);await loadDirectory()}

// --- Narrativas y señales digitales ---

// RC 2.2: registro de enlaces públicos. Sin scraping, sin acceso a cuentas privadas.
function narrativePlatform(url){try{const h=new URL(url).hostname.toLowerCase().replace(/^www\./,'');if(h==='linkedin.com'||h.endsWith('.linkedin.com'))return 'LinkedIn';if(h==='facebook.com'||h.endsWith('.facebook.com')||h==='fb.watch')return 'Facebook';if(h==='instagram.com'||h.endsWith('.instagram.com'))return 'Instagram';if(h==='tiktok.com'||h.endsWith('.tiktok.com'))return 'TikTok';if(h==='youtube.com'||h.endsWith('.youtube.com')||h==='youtu.be')return 'YouTube';if(['x.com','twitter.com'].includes(h))return 'X';return 'Otro medio público'}catch{return ''}}
function cleanSocialLink(link){if(!link)return '';try{const u=new URL(link.trim());if(!['http:','https:'].includes(u.protocol)||!u.hostname||u.username||u.password)throw Error('URL no permitida');return u.href}catch{return ''}}
function detectNarrativePlatform(){const url=$('#narLink')?.value.trim(),platform=narrativePlatform(url);if(platform&&platform!=='Otro medio público')$('#narFuente').value=platform}
function narrativeAlertScore(r){const intensity=normText(r.Intensidad),tone=normText(r.Tono),n=Number(r.Interacciones_Observadas)||0;let score=intensity.includes('alta')?45:intensity.includes('media')?25:10;score+=tone.includes('negativo')?25:tone.includes('mixto')?12:0;score+=n>=1000?25:n>=100?15:n>=10?8:0;return Math.min(100,score)}
function narrativeAlertLevel(score){return score>=70?'Alta':score>=40?'Media':'Baja'}

let narrativeData=[],selectedNarrative=null;
function toggleNarrativeForm(show){const el=$('#narrativeForm');const display=show===undefined?el.classList.contains('hidden'):show;el.classList.toggle('hidden',!display);if(display&&!$('#narFecha').value)$('#narFecha').value=today()}
async function loadNarratives(){narrativeData=forActiveProject(await api('/api/narrativas'));renderNarratives()}
function renderNarratives(){if(!$('#narrativeTable'))return;const q=normText($('#narSearch')?.value),tone=$('#narToneFilter')?.value||'ALL',state=$('#narStateFilter')?.value||'ALL';const rows=narrativeData.filter(r=>(!q||normText(JSON.stringify(r)).includes(q))&&(tone==='ALL'||displayText(r.Tono)===tone)&&(state==='ALL'||displayText(r.Estado)===state));$('#narrativeStats').innerHTML=[['Registros',narrativeData.length],['No verificadas',narrativeData.filter(r=>normText(r.Nivel_Verificacion).includes('no verificada')).length],['En seguimiento',narrativeData.filter(r=>normText(r.Estado).includes('seguimiento')).length],['Alertas digitales altas',narrativeData.filter(r=>r.URL_Publicacion&&narrativeAlertScore(r)>=70).length]].map(x=>`<div class="territorial-kpi"><i>◌</i><div><b>${x[1]}</b><span>${x[0]}</span></div></div>`).join('');$('#narrativeTable').innerHTML=rows.length?'<table><thead><tr><th>Fecha</th><th>Fuente</th><th>Tema</th><th>Actor</th><th>Tono</th><th>Intensidad</th><th>Estado</th></tr></thead><tbody>'+rows.map(r=>`<tr class="click-row" onclick="selectNarrative(${jsq(r._id)})"><td>${esc(r.Fecha_Inicio||'')}</td><td>${esc(displayText(r['Plataforma/Fuente']))}</td><td><b>${esc(displayText(r.Tema))}</b></td><td>${esc(displayText(r.Actor_Relacionado))}</td><td><span class="tag">${esc(displayText(r.Tono))}</span></td><td>${esc(displayText(r.Intensidad))}</td><td>${esc(displayText(r.Estado))}</td></tr>`).join('')+'</tbody></table>':'<div class="empty-state"><div><b>Sin coincidencias</b><span>Ajuste los filtros o registre una narrativa.</span></div></div>';if(!selectedNarrative||!rows.some(r=>r._id===selectedNarrative._id))selectedNarrative=rows[0]||null;renderNarrativeDetail()}
function selectNarrative(id){selectedNarrative=narrativeData.find(r=>r._id===id)||null;renderNarrativeDetail()}
function renderNarrativeDetail(){const r=selectedNarrative,el=$('#narrativeDetail');if(!el)return;if(!r){el.innerHTML='<div class="detail-empty"><div><strong>Sin selección</strong><span>Seleccione una narrativa para revisar su contexto.</span></div></div>';return}el.innerHTML=`<div class="detail-header"><div class="card-label">REVISIÓN HUMANA</div><h3>${esc(displayText(r.Tema)||'Narrativa sin tema')}</h3><small>${esc(displayText(r['Plataforma/Fuente'])||'Fuente por verificar')}</small></div><div class="detail-body"><div class="detail-badges"><span class="dim N">N</span><span class="tag">${esc(displayText(r.Tono)||'Sin tono')}</span><span class="tag">${esc(displayText(r.Intensidad)||'Sin intensidad')}</span></div><div class="detail-row"><span>Actor relacionado</span><b>${esc(displayText(r.Actor_Relacionado)||'No identificado')}</b></div>${cleanSocialLink(r.URL_Publicacion)?`<div class="detail-row"><span>Publicación original</span><b><a href="${esc(cleanSocialLink(r.URL_Publicacion))}" target="_blank" rel="noopener noreferrer">Abrir publicación ↗</a></b></div>`:''}<div class="detail-row"><span>Alerta de seguimiento</span><b>${narrativeAlertLevel(narrativeAlertScore(r))} (${narrativeAlertScore(r)}/100) · orientativa</b></div><div class="detail-row"><span>Interacciones registradas</span><b>${esc(String(r.Interacciones_Observadas??'Sin medir'))}</b></div><div class="detail-row"><span>Descripción</span><b>${esc(displayText(r.Descripcion)||'Sin descripción')}</b></div><div class="detail-row"><span>Verificación</span><b>${esc(displayText(r.Nivel_Verificacion)||'Por verificar')}</b></div><div class="detail-row"><span>Estado</span><b>${esc(displayText(r.Estado)||'En análisis')}</b></div><div class="data-caveat">El registro describe una señal o discurso. No equivale a un hecho confirmado ni a una medición automatizada de redes.</div></div>`}
async function saveNarrative(){const desc=$('#narDesc').value.trim(),rawLink=$('#narLink').value.trim(),link=cleanSocialLink(rawLink);if(rawLink&&!link){toast('Enlace inválido','Pegue un enlace público con https:// o http://.','error');return}if(!desc){toast('Falta la descripción','Describa la señal antes de guardar.','error');return}const p={...projectMeta(),Fecha_Inicio:$('#narFecha').value,Fecha_Observacion:$('#narObserved').value,URL_Publicacion:link,Interacciones_Observadas:Math.max(0,Math.floor(Number($('#narInteractions').value)||0)),'Plataforma/Fuente':narrativePlatform(link)||$('#narFuente').value.trim()||'Fuente por identificar',Tema:$('#narTema').value.trim()||'Por clasificar',Actor_Relacionado:$('#narActor').value.trim()||'No identificado',Tono:$('#narTono').value,Intensidad:$('#narIntensidad').value,Nivel_Verificacion:$('#narVer').value,Dimension:'N - Narrativas y señales digitales',Descripcion:desc,Fuente_ID:'',Estado:$('#narEstado').value};const r=await api('/api/narrativas',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});toast('Narrativa registrada',`Código ${r.id}`);['narFuente','narTema','narActor','narDesc','narLink'].forEach(id=>$('#'+id).value='');toggleNarrativeForm(false);await loadNarratives();loadDashboard()}

// --- Fuentes, metadatos y archivos vinculados ---
let sourceData=[],uploadData=[],selectedSource=null;
function toggleSourceForm(show){const el=$('#sourceForm');const display=show===undefined?el.classList.contains('hidden'):show;el.classList.toggle('hidden',!display);if(display&&!$('#srcFecha').value)$('#srcFecha').value=today()}
async function loadSources(q=''){[sourceData,uploadData]=await Promise.all([api('/api/fuentes'+(q?`?q=${encodeURIComponent(q)}`:'')),api('/system/uploads'+(q?`?q=${encodeURIComponent(q)}`:''))]);sourceData=forActiveProject(sourceData);uploadData=uploadData.filter(x=>(x.project_id||DEFAULT_PROJECT_ID)===activeProjectId);renderSources()}
function renderSources(){if(!$('#sourceTable'))return;const uploaded=new Map(uploadData.map(x=>[x.linked_record_id,x]));$('#sourceStats').innerHTML=[['Fuentes registradas',sourceData.length],['Archivos cargados',uploadData.length],['Con archivo disponible',sourceData.filter(r=>uploaded.has(r._id)).length],['Pendientes de revisión',sourceData.filter(r=>/no verificada|opini|percep/i.test(normText(r.Nivel_Base_Verificacion))).length]].map(x=>`<div class="territorial-kpi"><i>▰</i><div><b>${x[1]}</b><span>${x[0]}</span></div></div>`).join('');$('#sourceTable').innerHTML=sourceData.length?'<table><thead><tr><th>ID</th><th>Fecha</th><th>Archivo / fuente</th><th>Tipo</th><th>Institución / autor</th><th>Nivel</th><th>Archivo</th></tr></thead><tbody>'+sourceData.map(r=>{const u=uploaded.get(r._id);return `<tr class="click-row" onclick="selectSource(${jsq(r._id)})"><td>${esc(r._id)}</td><td>${esc(r.Fecha_Documento||'')}</td><td><b>${esc(displayText(r.Archivo_Fuente)||'Registro sin archivo')}</b></td><td>${esc(displayText(r.Tipo_Fuente))}</td><td>${esc(displayText(r['Institucion/Autor']))}</td><td><span class="tag">${esc(displayText(r.Nivel_Base_Verificacion)||'Por verificar')}</span></td><td>${u?`<span class="file-ok">✓ ${formatBytes(u.size_bytes)}</span>`:'<span class="muted">Sin carga local</span>'}</td></tr>`}).join('')+'</tbody></table>':'<div class="empty-state"><div><b>Aún no hay fuentes</b><span>Cargue el primer reporte o documento.</span></div></div>';if(!selectedSource||!sourceData.some(r=>r._id===selectedSource._id))selectedSource=sourceData[0]||null;renderSourceDetail()}
function selectSource(id){selectedSource=sourceData.find(r=>r._id===id)||null;renderSourceDetail()}
function renderSourceDetail(){const r=selectedSource,el=$('#sourceDetail');if(!el)return;if(!r){el.innerHTML='<div class="detail-empty"><div><strong>Seleccione una fuente</strong><span>Verá sus metadatos y archivo vinculado.</span></div></div>';return}const files=uploadData.filter(x=>x.linked_record_id===r._id);el.innerHTML=`<div class="detail-header"><div class="card-label">DETALLE DE EVIDENCIA</div><h3>${esc(displayText(r.Archivo_Fuente)||r._id)}</h3><small>${esc(displayText(r.Tipo_Fuente)||'Tipo por clasificar')}</small></div><div class="detail-body"><div class="detail-row"><span>Institución / autor</span><b>${esc(displayText(r['Institucion/Autor'])||'Por registrar')}</b></div><div class="detail-row"><span>Fecha / periodo</span><b>${esc(r.Fecha_Documento||'Sin fecha')} · ${esc(displayText(r.Periodo_Cubierto)||'Sin periodo')}</b></div><div class="detail-row"><span>Nivel de verificación</span><b>${esc(displayText(r.Nivel_Base_Verificacion)||'Por verificar')}</b></div><div class="detail-row"><span>Observaciones</span><b>${esc(displayText(r.Observaciones)||'Sin observaciones')}</b></div><div class="detail-row"><span>Archivos vinculados</span><b>${files.length?files.map(f=>`<a class="download-link" href="${f.download_url}">⇩ ${esc(f.original_name)} · ${formatBytes(f.size_bytes)}</a>`).join(''): 'No hay archivo local vinculado'}</b></div>${files.length?`<div class="integrity-box"><b>Integridad registrada</b><span>SHA-256: ${esc(files[0].sha256.slice(0,16))}…</span></div>`:''}<div class="data-caveat">El nivel de verificación es un atributo metodológico y no certifica autenticidad legal del documento.</div></div>`}
async function saveSourceWithFile(){const input=$('#srcFile'),file=input?.files?.[0];if(!file){toast('Falta el archivo','Seleccione un reporte o documento para cargar.','error');return}const p={...projectMeta(),Fecha_Documento:$('#srcFecha').value,Archivo_Fuente:file.name,Tipo_Fuente:$('#srcTipo').value,'Institucion/Autor':$('#srcAutor').value.trim()||'Por registrar',Periodo_Cubierto:$('#srcPeriodo').value.trim(),Nivel_Base_Verificacion:$('#srcVer').value,Observaciones:$('#srcObs').value.trim()};const r=await api('/api/fuentes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});try{await uploadFiles([file],'fuentes',r.id,{document_type:$('#srcTipo').value,author:$('#srcAutor').value.trim(),verification:$('#srcVer').value,notes:$('#srcObs').value.trim()});toast('Fuente cargada',`Código ${r.id} · ${file.name}`);toggleSourceForm(false);input.value='';$('#sourceFileList').innerHTML='';await loadSources()}catch(err){toast('Fuente creada, archivo pendiente','Revise que el formato esté permitido y no supere 10 MB.','error');await loadSources()}}

// --- Administración demostrativa de usuarios y roles ---
let userData=[],roleData=[];
async function loadAdministration(){[userData,roleData]=await Promise.all([api('/api/usuarios'),api('/api/roles')]);await loadProjects();const roleNames=roleData.map(r=>r.Nombre).filter(Boolean);$('#usrRol').innerHTML=roleNames.map(x=>`<option>${esc(x)}</option>`).join('');$('#userRoleFilter').innerHTML='<option value="ALL">Todos los roles</option>'+roleNames.map(x=>`<option>${esc(x)}</option>`).join('');renderUsers();renderRoles();renderProjects()}
function renderProjects(){const el=$('#projectList');if(!el)return;el.innerHTML=projectData.map(p=>{const geo=p._id===DEFAULT_PROJECT_ID&&projectCoordinateData?`<span class="project-spatial-meta">⌖ ${projectCoordinateData.summary.concession_count} concesiones · ${projectCoordinateData.crs.label} · ${hectares(projectCoordinateData.summary.nominal_area_total_ha)} nominales</span>`:'';return `<div class="project-row ${p._id===activeProjectId?'current':''}"><div><b>${esc(p.Nombre)}</b><span>${esc(p.Territorio||'Territorio por definir')} · ${esc(p.Descripcion||'Sin descripción')}</span>${geo}</div><span class="tag ${p.Estado==='Activo'?'ok':'warn'}">${esc(p.Estado||'Activo')}</span><div class="row-actions"><button class="row-action" onclick="activateProject(${jsq(p._id)})" ${p.Estado==='Inactivo'?'disabled':''} title="Seleccionar proyecto">✓</button><button class="row-action" onclick="editProject(${jsq(p._id)})" title="Editar proyecto">✎</button><button class="row-action" onclick="toggleProjectStatus(${jsq(p._id)})" title="Activar o desactivar">◉</button></div></div>`}).join('')}
function toggleProjectForm(show){const el=$('#projectForm'),display=show===undefined?el.classList.contains('hidden'):show;el.classList.toggle('hidden',!display);if(!display){['projectIdEdit','projectName','projectTerritory','projectDescription'].forEach(id=>{if($('#'+id))$('#'+id).value=''});$('#projectStatus').value='Activo'}else setTimeout(()=>$('#projectName')?.focus(),20)}
function editProject(id){const p=projectData.find(x=>x._id===id);if(!p)return;$('#projectIdEdit').value=id;$('#projectName').value=p.Nombre||'';$('#projectTerritory').value=p.Territorio||'';$('#projectDescription').value=p.Descripcion||'';$('#projectStatus').value=p.Estado||'Activo';toggleProjectForm(true)}
async function saveProject(){const name=$('#projectName').value.trim();if(!name){toast('Falta el nombre','Ingrese el nombre del proyecto.','error');return}const id=$('#projectIdEdit').value;if(id===DEFAULT_PROJECT_ID&&$('#projectStatus').value==='Inactivo'){toast('Proyecto predeterminado','Proyecto Sechura debe permanecer activo para los registros históricos.','error');return}const p={Proyecto_ID:id||undefined,Nombre:name,Territorio:$('#projectTerritory').value.trim(),Descripcion:$('#projectDescription').value.trim(),Estado:$('#projectStatus').value,Fecha_Creacion:today()};if(!p.Proyecto_ID)delete p.Proyecto_ID;const r=await api(id?`/api/proyectos/${encodeURIComponent(id)}`:'/api/proyectos',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});toast(id?'Proyecto actualizado':'Proyecto creado',name);toggleProjectForm(false);await loadProjects();renderProjects();if(!id&&r.id)await activateProject(r.id)}
async function activateProject(id){const p=projectData.find(x=>x._id===id);if(!p||p.Estado==='Inactivo')return;activeProjectId=id;updateProjectContext();if($('#projectSelector'))$('#projectSelector').value=id;renderProjects();toast('Proyecto activo',p.Nombre)}
async function toggleProjectStatus(id){const p=projectData.find(x=>x._id===id);if(!p)return;if(id===DEFAULT_PROJECT_ID&&p.Estado!=='Inactivo'){toast('Proyecto predeterminado','Proyecto Sechura debe permanecer activo para los registros históricos.','error');return}const payload={...p,Estado:p.Estado==='Inactivo'?'Activo':'Inactivo'};delete payload._id;delete payload._updated_at;await api(`/api/proyectos/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload})});if(id===activeProjectId&&payload.Estado==='Inactivo')activeProjectId=DEFAULT_PROJECT_ID;await loadProjects();renderProjects();toast('Estado del proyecto',`${p.Nombre}: ${payload.Estado}`)}
function renderUsers(){if(!$('#userTable'))return;const q=normText($('#userSearch')?.value),role=$('#userRoleFilter')?.value||'ALL',status=$('#userStatusFilter')?.value||'ALL';const rows=userData.filter(r=>(!q||normText(JSON.stringify(r)).includes(q))&&(role==='ALL'||r.Rol===role)&&(status==='ALL'||r.Estado===status));$('#adminStats').innerHTML=[['Usuarios',userData.length],['Activos',userData.filter(r=>r.Estado==='Activo').length],['Roles',roleData.length],['Sin acceso registrado',userData.filter(r=>!r.Ultimo_Acceso||r.Ultimo_Acceso==='No disponible').length]].map(x=>`<div class="territorial-kpi"><i>⚙</i><div><b>${x[1]}</b><span>${x[0]}</span></div></div>`).join('');$('#userTable').innerHTML=rows.length?'<table><thead><tr><th>Nombre</th><th>Cargo</th><th>Correo</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th>Acciones</th></tr></thead><tbody>'+rows.map(r=>`<tr><td><b>${esc(r.Nombre)}</b></td><td>${esc(r.Cargo||'')}</td><td>${esc(r.Correo||'No registrado')}</td><td><span class="role-pill">${esc(r.Rol)}</span></td><td><span class="tag ${r.Estado==='Activo'?'ok':r.Estado==='Suspendido'?'warn':''}">${esc(r.Estado)}</span></td><td>${esc(r.Ultimo_Acceso||'No disponible')}</td><td><div class="row-actions"><button class="row-action" onclick="editUser(${jsq(r._id)})" aria-label="Editar usuario">✎</button><button class="row-action" onclick="toggleUserState(${jsq(r._id)})" aria-label="Cambiar estado">◉</button></div></td></tr>`).join('')+'</tbody></table>':'<div class="empty-state"><div><b>Sin coincidencias</b><span>Ajuste la búsqueda o los filtros.</span></div></div>'}
function renderRoles(){$('#roleList').innerHTML=roleData.map(r=>`<div class="role-card"><div><b>${esc(r.Nombre)}</b><span>${esc(r.Descripcion||'')}</span></div><small>${esc(r.Permisos||'Permisos por definir')}</small></div>`).join('')}
function toggleUserForm(show){const el=$('#userForm'),display=show===undefined?el.classList.contains('hidden'):show;el.classList.toggle('hidden',!display);if(!display)clearUserForm();else setTimeout(()=>$('#usrNombre')?.focus(),20)}
function clearUserForm(){['userId','usrNombre','usrCargo','usrCorreo'].forEach(id=>{if($('#'+id))$('#'+id).value=''});if($('#usrEstado'))$('#usrEstado').value='Activo';if($('#usrAcceso'))$('#usrAcceso').value='No disponible';if($('#userFormMode'))$('#userFormMode').textContent='NUEVO USUARIO'}
function editUser(id){const r=userData.find(x=>x._id===id);if(!r)return;$('#userId').value=id;$('#usrNombre').value=r.Nombre||'';$('#usrCargo').value=r.Cargo||'';$('#usrCorreo').value=r.Correo||'';$('#usrRol').value=r.Rol||roleData[0]?.Nombre||'';$('#usrEstado').value=r.Estado||'Activo';$('#usrAcceso').value=r.Ultimo_Acceso||'No disponible';$('#userFormMode').textContent='EDITAR USUARIO';toggleUserForm(true)}
async function saveUser(){const name=$('#usrNombre').value.trim();if(!name){toast('Falta el nombre','Ingrese el nombre del usuario.','error');return}const id=$('#userId').value,p={Nombre:name,Cargo:$('#usrCargo').value.trim(),Correo:$('#usrCorreo').value.trim(),Rol:$('#usrRol').value,Estado:$('#usrEstado').value,Ultimo_Acceso:$('#usrAcceso').value||'No disponible'};await api(id?`/api/usuarios/${encodeURIComponent(id)}`:'/api/usuarios',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});toast(id?'Usuario actualizado':'Usuario creado','Cambio guardado en el prototipo.');toggleUserForm(false);await loadAdministration()}
async function toggleUserState(id){const r=userData.find(x=>x._id===id);if(!r)return;const p={...r,Estado:r.Estado==='Activo'?'Inactivo':'Activo'};delete p._id;delete p._updated_at;await api(`/api/usuarios/${encodeURIComponent(id)}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:p})});toast('Estado actualizado',`${r.Nombre}: ${p.Estado}`);await loadAdministration()}

async function refresh(p){
  try{
    if(p==='dashboard'){await loadDashboard();await loadIRSA();await loadModelStatus()}
    if(p==='gerencia')await loadRC28Management();
    if(p==='eventos')await loadTable('eventos','eventTable');
    if(p==='actores')await Promise.all([loadTable('actores','actorTable'),loadActorNetwork()]);
    if(p==='directorio')await loadDirectory();
    if(p==='demandas')await loadTable('demandas','demandTable');
    if(p==='narrativas')await loadNarratives();
    if(p==='inteligencia-redes'){await loadSocialIntelligence();await loadRC26Reviews();await loadRC27Actions();}
    if(p==='alertas')await loadTable('alertas','alertTable');
    if(p==='mapa')await loadTerritorialMap();
    if(p==='situacion')await loadSituational();
    if(p==='estrategia')await loadStrategic();
    if(p==='irsa')await loadIRSA();
    if(p==='validacion')await loadValidation();
    if(p==='fuentes')await loadSources();
    if(p==='administracion')await loadAdministration();
    if(p==='audit')await loadAudit();
  }catch(err){console.error(err);toast('No se pudo actualizar la vista','Verifique que el servidor MASCLI esté activo.','error')}
}

(async()=>{try{const scope=await api('/system/auth/current-scope');DEFAULT_PROJECT_ID=scope.project_id;activeProjectId=DEFAULT_PROJECT_ID;}catch(e){}await loadProjects();await loadDashboard();await loadIRSA();await loadModelStatus();})();

async function loadSituational(){
 const d=await api('/system/situational-analysis?project_id='+encodeURIComponent(activeProjectId));
 const list=(items,format)=>items.length?'<ul class="principles">'+items.map(x=>'<li>'+format(x)+'</li>').join('')+'</ul>':'<p class="muted">Sin registros en esta categoría.</p>';
 const kv=(o,k)=>esc(o[k]||'No consignado');
 $('#situationalContent').innerHTML=`<div class="card-label">${esc(d.project_name)} · Corte ${esc(d.generated_at)} · BORRADOR</div>
 <h3>Resumen ejecutivo</h3><p>Base Maestra: ${d.counts.eventos} eventos, ${d.counts.actores} actores, ${d.demandas_pendientes} demandas pendientes, ${d.alertas_activas} alertas activas. Son conteos de registros, no comprobación independiente de hechos.</p>
 <h3>Lectura de la situación</h3>${list(d.observaciones,x=>esc(x))}
 <h3>Territorios con eventos registrados</h3>${list(d.territorios,x=>esc(x[0])+' — '+x[1]+' registros')}
 <h3>Problemáticas / demandas</h3>${list(d.demandas_abiertas,x=>'<b>'+kv(x,'id')+' · '+kv(x,'Tema')+'</b>: '+kv(x,'Descripcion')+' <small>Fuente: '+kv(x,'Fuente_ID')+'</small>')}
 <h3>Alertas prioritarias</h3>${list(d.alertas_prioritarias,x=>'<b>'+kv(x,'id')+' · '+kv(x,'Nivel_Preliminar')+'</b>: '+kv(x,'Causa')+' <small>Fuente: '+kv(x,'Fuente_ID')+'</small>')}
 <h3>Escenarios condicionales</h3>${list(d.escenarios,x=>'<b>'+kv(x,'nombre')+'</b>: '+kv(x,'supuesto'))}
 <h3>Recomendaciones de gestión</h3>${list(d.recomendaciones,x=>esc(x))}
 <h3>Limitaciones metodológicas</h3>${list(d.limitations,x=>esc(x))}
 <p class="method-note">Elaboración automática MASCLI · Validación del analista pendiente.</p>`;
}
async function loadIntegratedAnalysis(){
 const el=$('#integratedAnalysis');if(!el)return;
 try{
  const d=await api('/system/integrated-analysis?project_id='+encodeURIComponent(activeProjectId));
  let html=`<div class="strategy-head"><div><div class="card-label">ANÁLISIS INTERMODULAR · RC 1.9</div><h3>Conexiones, rutas de acción y escenarios</h3><p>${d.summary.cruces_candidatos} cruces candidatos · ${d.summary.acciones_sugeridas} acciones sugeridas · ${d.summary.registros_estrategicos} registros</p></div><button class="secondary" onclick="window.location.href='/system/integrated-analysis.docx?project_id='+encodeURIComponent(activeProjectId)">Exportar análisis Word</button></div>`;
  html+=`<h4>Posibles relaciones entre registros (requieren verificación)</h4>`;
  html+=d.candidate_links.length?d.candidate_links.slice(0,25).map(x=>`<article class="engine-card"><b>${esc(x.origen)} ↔ ${esc(x.destino)}</b><p>${esc(x.criterio)} · ${esc(x.terminos_compartidos.join(', ')||'Referencia registrada')}</p><small>${esc(x.estado)}</small></article>`).join(''):'<p>No hay cruces con evidencia textual suficiente. Puedes añadir referencias de IDs para mejorar la trazabilidad.</p>';
  html+=`<h4>Escenarios condicionales</h4>`+d.scenarios.map(x=>`<article class="engine-card"><b>${esc(x.tipo)}</b><p>${esc(x.supuesto)}</p><small>Seguimiento: ${esc(x.indicadores_a_observar.join(' · '))}</small></article>`).join('');
  html+=`<p class="method-note">${d.limitations.map(esc).join(' ')}</p>`;el.innerHTML=html;
 }catch(e){el.textContent='No se pudo cargar el análisis integrado: '+String(e.message||e)}
}
function downloadSituational(){window.location.href='/system/situational-report.docx?project_id='+encodeURIComponent(activeProjectId)}


// RC 1.7 — herramientas estratégicas agregadas sin modificar el IRSA.
const STRATEGY_SCHEMA={
 intereses:{title:'Actores e intereses',desc:'Separar posiciones, intereses y necesidades sin inferir motivaciones personales.',fields:[['Actor','Actor u organización'],['Posicion','Posición expresada'],['Interes','Interés manifestado'],['Preocupacion','Preocupación o demanda'],['Mandato','Mandato o legitimidad documental'],['Alternativa','Alternativa ante la falta de acuerdo (BATNA)'],['Fuente_ID','Fuente o evidencia'],['Estado','Estado de verificación']]},
 dialogos:{title:'Diálogo y construcción de consensos',desc:'Diseñar el proceso y trazar propuestas, desacuerdos y resultados.',fields:[['Proceso','Nombre del proceso'],['Participantes','Participantes'],['Tema','Temas y reglas de diálogo'],['Opciones','Opciones consideradas'],['Acuerdo','Acuerdo o desacuerdo'],['Responsable','Responsable'],['Proximo_Paso','Próximo paso y plazo'],['Fuente_ID','Acta o evidencia'],['Estado','Estado del proceso']]},
 oportunidades:{title:'Valor compartido',desc:'Distinguir propuestas preliminares de compromisos aprobados y beneficios realizados.',fields:[['Oportunidad','Oportunidad identificada'],['Tipo','Tipo (empleo, proveedores, capacitación, servicios, etc.)'],['Beneficiarios','Posibles beneficiarios'],['Viabilidad','Condiciones de viabilidad'],['Restricciones','Restricciones técnicas/legales'],['Responsable','Responsable potencial'],['Plazo','Plazo referencial'],['Fuente_ID','Fuente o sustento'],['Estado','Estado (propuesta, en evaluación, aprobada, etc.)']]},
 hechos:{title:'Hechos compartidos y verificación',desc:'Documentar controversias y facilitar la validación conjunta (Joint Fact Finding).',fields:[['Asunto','Pregunta o asunto por verificar'],['Versiones','Versiones o información discrepante'],['Preguntas','Preguntas acordadas'],['Metodo','Método de contrastación'],['Participantes','Actores participantes'],['Fuente_ID','Fuentes o evidencia'],['Accion_Verificacion','Siguiente acción de verificación'],['Estado','Estado (pendiente, en contraste, validado, etc.)']]},
 aarc:{title:'AARC · Calidad del relacionamiento',desc:'Evaluación cualitativa: reconocimiento, agencia, reciprocidad y claridad, con sustento.',fields:[['Actor_Proceso','Actor o proceso evaluado'],['Reconocimiento','Reconocimiento de experiencias y preocupaciones'],['Agencia','Capacidad efectiva de participar e influir'],['Reciprocidad','Reciprocidad y opciones de valor mutuo'],['Claridad','Claridad de reglas, información y compromisos'],['Evidencia','Evidencia observable'],['Accion_Mejora','Acción de mejora'],['Fecha','Fecha de evaluación'],['Estado','Estado de revisión']]}
};
let strategicModule='intereses',strategicRows=[],strategicEditing=null;
async function loadStrategic(){
 const r=await api('/system/strategic-assessment?project_id='+encodeURIComponent(activeProjectId));
 const labels={intereses:'Intereses documentados',dialogos:'Procesos de diálogo',oportunidades:'Oportunidades',hechos:'Hechos por verificar',aarc:'Evaluaciones AARC'};
 $('#strategyKpis').innerHTML=Object.entries(labels).map(([key,label])=>`<div class="kpi"><span>${esc(label)}</span><b>${r.counts[key]||0}</b></div>`).join('');
 const attention=r.attention.length?r.attention.map(x=>`<li>${esc(x)}</li>`).join(''):'<li>No existen suficientes señales registradas para identificar prioridades en esta capa.</li>';
 $('#strategySummary').innerHTML=`<p><b>${r.facts_pending}</b> hechos pendientes de validación · <b>${r.dialogues_open}</b> diálogos en seguimiento · <b>${r.opportunities_open}</b> oportunidades no cerradas.</p><ul class="principles">${attention}</ul><p class="method-note">${r.limitations.map(esc).join(' ')}</p>`;
 $('#strategyTabs').innerHTML=Object.entries(STRATEGY_SCHEMA).map(([slug,x])=>`<button class="secondary ${slug===strategicModule?'tab-active':''}" onclick="switchStrategic(${jsq(slug)})">${esc(x.title)}</button>`).join('');
 await loadStrategicTable();
 await loadConsensusEngine();
 await loadIntegratedAnalysis();
}
async function switchStrategic(slug){strategicModule=slug;strategicEditing=null;await loadStrategic()}
async function loadStrategicTable(){
 const cfg=STRATEGY_SCHEMA[strategicModule];strategicRows=forActiveProject(await api('/api/'+strategicModule+'?limit=500'));
 $('#strategyPanel').innerHTML=`<div class="strategy-head"><div><h3>${esc(cfg.title)}</h3><p>${esc(cfg.desc)}</p></div><button onclick="strategicForm()">＋ Nuevo registro</button></div><div id="strategicFormArea"></div><div class="strategy-table-wrap"><table><thead><tr><th>Registro</th><th>Descripción</th><th>Estado</th><th>Fuente</th><th>Acciones</th></tr></thead><tbody>${strategicRows.map(r=>`<tr><td><b>${esc(r._id)}</b></td><td>${esc(r[cfg.fields[0][0]]||'—')}<small>${esc(r[cfg.fields[1][0]]||'')}</small></td><td>${esc(r.Estado||'Por determinar')}</td><td>${esc(r.Fuente_ID||r.Evidencia||'No consignada')}</td><td><button class="secondary" onclick="strategicForm(${jsq(r._id)})">Editar</button></td></tr>`).join('')||'<tr><td colspan="5">Sin registros. Añada un registro verificable para comenzar.</td></tr>'}</tbody></table></div>`;
}
function strategicForm(id=''){
 strategicEditing=id||null;const cfg=STRATEGY_SCHEMA[strategicModule],r=strategicRows.find(x=>x._id===id)||{};
 $('#strategicFormArea').innerHTML=`<form class="strategy-form" id="strategyForm" onsubmit="saveStrategic(event)"><b>${id?'Editar registro':'Nuevo registro'} · ${esc(cfg.title)}</b><div class="strategy-fields">${cfg.fields.map(([key,label])=>`<label>${esc(label)}<textarea name="${key}" rows="2" placeholder="${esc(label)}">${esc(r[key]||'')}</textarea></label>`).join('')}</div><div class="actions"><button type="submit">Guardar registro</button><button type="button" class="secondary" onclick="$('#strategicFormArea').innerHTML=''">Cancelar</button></div></form>`;
 $('#strategyFormArea').scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function saveStrategic(event){
 event.preventDefault();const form=event.currentTarget,fields=Object.fromEntries(new FormData(form).entries());
 const required=STRATEGY_SCHEMA[strategicModule].fields[0][0];if(!String(fields[required]||'').trim()){toast('Campo obligatorio', 'Complete '+required,'error');return;}
 const payload={...fields,Proyecto_ID:activeProjectId,Proyecto:activeProject().Nombre};
 const url='/api/'+strategicModule+(strategicEditing?'/'+encodeURIComponent(strategicEditing):'');
 try{await api(url,{method:strategicEditing?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload})});toast('Registro guardado','Se actualizó la información estratégica.');strategicEditing=null;await loadStrategic();}catch(e){toast('No se pudo guardar',String(e.message||e),'error')}
}
function downloadStrategic(){window.location.href='/system/strategic-report.docx?project_id='+encodeURIComponent(activeProjectId)}

// RC 1.8 - motor accionable, explicable y separado de registros de hechos.
async function loadConsensusEngine(){
 const el=$('#consensusEngine'); if(!el)return;
 try {
  const d=await api('/system/consensus-engine?project_id='+encodeURIComponent(activeProjectId));
  let html=`<div class="strategy-head"><div><div class="card-label">REGLAS DE AUTOMATIZACIÓN · RC 1.9</div><h3>Motor de valor compartido y construcción de consensos</h3><p>${esc(d.method)} · ${d.summary.total} propuestas · ${d.summary.alta} de atención alta</p></div><button class="secondary" onclick="window.location.href='/system/consensus-engine.docx?project_id='+encodeURIComponent(activeProjectId)">Exportar propuestas Word</button></div>`;
  html+=d.recommendations.length?d.recommendations.map((x,i)=>`<article class="engine-card"><div><b>${i+1}. ${esc(x.titulo)}</b> <span class="engine-tag">${esc(x.tipo)}</span> <span class="engine-tag">${esc(x.prioridad_orientativa)}</span></div><p><b>Por qué aparece:</b> ${esc(x.motivo)}</p><p><b>Acción propuesta:</b> ${esc(x.accion_sugerida)}</p><small>Origen: ${esc(x.origen)} · ${esc(x.estado)}</small></article>`).join(''):'<p>No hay propuestas activadas por los registros disponibles. Esto no indica ausencia de riesgos.</p>';
  html+=`<p class="method-note">${d.limitations.map(esc).join(' ')}</p>`;
  el.innerHTML=html;
 }catch(e){el.textContent='No se pudo cargar el motor: '+String(e.message||e)}
}


// MASCLI RC 2.0: laboratorio de lectura documental en modo sólo análisis.
async function analyzeMascliDocument(ev){
 ev.preventDefault();const f=$('#docLabFile')?.files?.[0];if(!f)return;
 const area=$('#docLabResults');area.textContent='Analizando documento...';
 const fd=new FormData();fd.append('file',f);fd.append('project_id',activeProjectId);
 try{
  const response=await fetch('/system/document-lab/analyze',{method:'POST',body:fd});
  const data=await response.json();if(!response.ok)throw Error(data.detail||response.statusText);
  window.mascliDocumentResult=data;
  let h=`<div class="strategy-head"><div><h3>${esc(data.filename)}</h3><p>${data.text_sections} secciones · ${data.items.length} fragmentos candidatos · SHA256: ${esc(data.sha256.slice(0,16))}…</p></div></div>`;
  h+=`<p class="method-note">${esc(data.method)}</p>`;
  h+=`<div class="strategy-kpis">${Object.entries(data.themes).map(([k,v])=>`<div class="kpi"><span>${esc(k)}</span><b>${v}</b></div>`).join('')}</div>`;
  h+='<h4>Fragmentos y recomendaciones revisables</h4><div class="strategy-table-wrap"><table><thead><tr><th>Ubicación</th><th>Tema</th><th>Fragmento original</th><th>Acción sugerida</th></tr></thead><tbody>';
  h+=data.items.map(x=>`<tr><td>${esc(x.ubicacion)}</td><td>${esc(x.tema)}</td><td>${esc(x.fragmento)}</td><td>${esc(x.accion_sugerida)}<small>${esc(x.estado)}</small></td></tr>`).join('');
  h+='</tbody></table></div><p class="method-note">'+data.limitations.map(esc).join(' ')+'</p>';area.innerHTML=h;
 }catch(err){area.textContent='No se pudo analizar: '+String(err.message||err)}
}
async function exportMascliDocument(){
 const f=$('#docLabFile')?.files?.[0];if(!f){toast('Selecciona primero un archivo','','error');return}
 const fd=new FormData();fd.append('file',f);fd.append('project_id',activeProjectId);
 try{const res=await fetch('/system/document-lab/report.docx',{method:'POST',body:fd});if(!res.ok){const e=await res.json();throw Error(e.detail||'Error')}
 const blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='MASCLI_RC20_Lectura_Documental.docx';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
 }catch(err){toast('Error en exportación',String(err.message||err),'error')}
}


// RC 2.1: flujos de comparación, revisión y decisiones verificables.
async function importMascliFindings(){
 const d=window.mascliDocumentResult;if(!d){toast('Analiza un archivo primero','','error');return}
 try{const r=await fetch('/system/document-lab/review/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project_id:activeProjectId,filename:d.filename,sha256:d.sha256,items:d.items})});const x=await r.json();if(!r.ok)throw Error(x.detail||'Error');toast('Bandeja actualizada',`${x.new_items} hallazgos nuevos`);await loadMascliReviews()}catch(e){toast('Error',String(e.message),'error')}
}
async function loadMascliReviews(){
 const el=$('#docReviewResults');if(!el)return;el.textContent='Cargando...';
 try{const r=await fetch('/system/document-lab/review?project_id='+encodeURIComponent(activeProjectId));const d=await r.json();if(!r.ok)throw Error(d.detail||'Error');
 el.innerHTML=d.items.length?d.items.map(x=>`<div class="card" style="padding:12px;margin-bottom:9px"><b>${esc(x.theme)} · ${esc(x.source_file)}</b><p class="muted">${esc(x.location)} · ${esc(x.status)}</p><p>${esc(x.excerpt)}</p><div class="actions"><button class="secondary" onclick="decideMascliReview(${jsq(x.id)},'aceptado_para_revision')">Para revisión</button><button class="secondary" onclick="decideMascliReview(${jsq(x.id)},'descartado')">Descartar</button><button onclick="decideMascliReview(${jsq(x.id)},'corroborado_documentalmente')">Corroborar con evidencia</button></div><small>${esc(x.note||'Sin nota')}</small></div>`).join(''):'<p class="muted">Sin hallazgos guardados para este proyecto.</p>';
 }catch(e){el.textContent='Error: '+String(e.message)}
}
async function decideMascliReview(id,status){
 const note=prompt(status==='corroborado_documentalmente'?'Describa la evidencia contrastada (obligatoria):':'Nota de revisión (opcional):');if(note===null)return;
 if(status==='corroborado_documentalmente'&&!note.trim()){toast('Requiere evidencia','Indique la fuente contrastada.','error');return}
 const reviewer=prompt('Nombre de quien revisa:','Crystell Granda');if(reviewer===null)return;
 try{const r=await fetch('/system/document-lab/review/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,note,reviewer})});const d=await r.json();if(!r.ok)throw Error(d.detail||'Error');await loadMascliReviews()}catch(e){toast('Error',String(e.message),'error')}
}
async function compareMascliDocs(ev){
 ev.preventDefault();const el=$('#docCompareResults');el.textContent='Comparando...';const fd=new FormData();fd.append('file_a',$('#docCompareA').files[0]);fd.append('file_b',$('#docCompareB').files[0]);fd.append('project_id',activeProjectId);
 try{const r=await fetch('/system/document-lab/compare',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw Error(d.detail||'Error');
 let h=`<p class="method-note">${esc(d.method)} · ${d.total_candidatos} coincidencias candidatas. No constituyen contradicciones confirmadas.</p>`;
 h+=d.comparaciones.map(x=>`<div class="card" style="padding:12px;margin-bottom:9px"><b>${esc(x.tema)}</b><p><b>${esc(d.documents[0].filename)} · ${esc(x.a.ubicacion)}:</b> ${esc(x.a.fragmento)}</p><p><b>${esc(d.documents[1].filename)} · ${esc(x.b.ubicacion)}:</b> ${esc(x.b.fragmento)}</p><small>Coincidencias: ${esc(x.terminos_comunes.join(', '))}. ${esc(x.advertencia)}</small></div>`).join('');
 el.innerHTML=h||'Sin coincidencias';
 }catch(e){el.textContent='Error: '+String(e.message)}
}


// RC 2.3: análisis descriptivo de registros observados; no se realizan conexiones con APIs de redes.
let socialRecords=[];
async function loadSocialIntelligence(){socialRecords=forActiveProject(await api('/api/narrativas'));renderSocialIntelligence()}
function socialDate(r){return String(r.Fecha_Observacion||r.Fecha_Inicio||'').slice(0,10)}
function socialFiltered(){const platform=$('#socialPlatform')?.value||'ALL',from=$('#socialFrom')?.value||'',to=$('#socialTo')?.value||'',priority=$('#socialPriority')?.value||'ALL';return socialRecords.filter(r=>{const d=socialDate(r),p=narrativePlatform(r.URL_Publicacion)||displayText(r['Plataforma/Fuente'])||'Sin identificar';return (platform==='ALL'||p===platform)&&(!from||!!d&&d>=from)&&(!to||!!d&&d<=to)&&(priority==='ALL'||narrativeAlertLevel(narrativeAlertScore(r))===priority)})}
function socialBars(id,pairs){const el=$('#'+id);if(!el)return;const max=Math.max(1,...pairs.map(x=>x[1]));el.innerHTML=pairs.length?pairs.map(([name,n])=>`<div class="social-bar-row"><span title="${esc(name)}">${esc(name)}</span><div class="social-track"><i style="width:${Math.round(n/max*100)}%"></i></div><b>${n}</b></div>`).join(''):'<p class="muted">Sin registros para estos filtros.</p>'}
function groupSocial(rows,getKey){const counts={};rows.forEach(r=>{const key=getKey(r)||'Sin identificar';counts[key]=(counts[key]||0)+1});return Object.entries(counts).sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))}
function renderSocialIntelligence(){if(!$('#socialKpis'))return;const rows=socialFiltered(),high=rows.filter(r=>narrativeAlertScore(r)>=70),withLink=rows.filter(r=>!!cleanSocialLink(r.URL_Publicacion)),unverified=rows.filter(r=>/no verificada|opini[oó]n/i.test(String(r.Nivel_Verificacion||'')));$('#socialKpis').innerHTML=[['Registros',rows.length],['Alertas altas orientativas',high.length],['Con enlace',withLink.length],['No verificadas / opiniones',unverified.length]].map(([label,v])=>`<div class="territorial-kpi"><i>◌</i><div><b>${v}</b><span>${esc(label)}</span></div></div>`).join('');socialBars('socialTimeline',groupSocial(rows.filter(r=>/^\d{4}-\d{2}/.test(socialDate(r))),r=>socialDate(r).slice(0,7)).sort((a,b)=>a[0].localeCompare(b[0])));socialBars('socialPlatformChart',groupSocial(rows,r=>narrativePlatform(r.URL_Publicacion)||displayText(r['Plataforma/Fuente'])));socialBars('socialThemes',groupSocial(rows,r=>displayText(r.Tema)).slice(0,10));socialBars('socialLevels',['Alta','Media','Baja'].map(l=>[l,rows.filter(r=>narrativeAlertLevel(narrativeAlertScore(r))===l).length]));const sorted=[...rows].sort((a,b)=>narrativeAlertScore(b)-narrativeAlertScore(a)||socialDate(b).localeCompare(socialDate(a)));$('#socialAlertsTable').innerHTML=sorted.length?`<table><thead><tr><th>Fecha observada</th><th>Plataforma</th><th>Tema</th><th>Prioridad</th><th>Interacciones</th><th>Verificación</th><th>Fuente</th></tr></thead><tbody>${sorted.map(r=>{const link=cleanSocialLink(r.URL_Publicacion),score=narrativeAlertScore(r);return `<tr><td>${esc(socialDate(r)||'Sin fecha')}</td><td>${esc(narrativePlatform(link)||displayText(r['Plataforma/Fuente']))}</td><td>${esc(displayText(r.Tema))}</td><td><span class="tag">${narrativeAlertLevel(score)} · ${score}/100</span></td><td>${esc(String(r.Interacciones_Observadas??'Sin dato'))}</td><td>${esc(displayText(r.Nivel_Verificacion))}</td><td>${link?`<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">Ver publicación ↗</a>`:'Sin enlace'}</td></tr>`}).join('')}</tbody></table>`:'<div class="empty-state">No hay publicaciones para estos filtros.</div>'}
function exportSocialCSV(){const rows=socialFiltered(),headers=['Proyecto','Fecha observada','Plataforma','Tema','Tono','Intensidad','Interacciones','Prioridad','Puntaje','Verificación','URL'];const vals=rows.map(r=>[activeProject().Nombre,socialDate(r),narrativePlatform(r.URL_Publicacion)||displayText(r['Plataforma/Fuente']),displayText(r.Tema),displayText(r.Tono),displayText(r.Intensidad),r.Interacciones_Observadas??'',narrativeAlertLevel(narrativeAlertScore(r)),narrativeAlertScore(r),displayText(r.Nivel_Verificacion),cleanSocialLink(r.URL_Publicacion)]);const quote=x=>'"'+String(x??'').replace(/"/g,'""')+'"';const csv='\ufeff'+[headers,...vals].map(row=>row.map(quote).join(';')).join('\r\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='MASCLI_RC_2_3_redes_'+new Date().toISOString().slice(0,10)+'.csv';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url)}

// RC 2.4 — lectura textual asistida y trazable. API no guarda el texto.
async function analyzeRC24(){
 const target=$('#rc24Results'),content=$('#rc24Text')?.value.trim(),link=$('#rc24Link')?.value.trim()||'';
 if(!content){toast('Falta texto','Copie texto de una publicación o documento para analizar.','error');return}
 if(link&&!cleanSocialLink(link)){toast('Enlace inválido','Utilice una URL pública http(s).','error');return}
 target.textContent='Procesando texto…';
 try{
  const d=await api('/system/intelligence/semantic-analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:content,project_id:activeProjectId,source_url:link,mode:$('#rc25Mode')?.value||'automatic'})});
  const items=(arr,fn)=>arr.length?'<ul>'+arr.map(fn).join('')+'</ul>':'<p>No se encontraron coincidencias en el vocabulario configurado.</p>';
  target.innerHTML=`<div class="detail-row"><span>Prioridad orientativa de revisión</span><b>${esc(d.orientation.level)} · ${esc(d.orientation.score)}/100</b></div>
   <h4>Evaluación semántica</h4><p>${esc(d.semantic?.active?'Modelo local activo':'Sin modelo semántico activo')} — ${esc(d.semantic?.method||'')}</p><p>${esc(d.semantic?.note||'')}</p>${items(d.semantic?.matches||[],t=>`<li><b>${esc(t.theme)}</b> — similitud ${esc(t.similarity)} · referencia: ${esc(t.reference)}</li>`)}
   <h4>Temas detectados por reglas</h4>${items(d.topics,t=>`<li><b>${esc(t.tema)}</b> — términos: ${esc(t.terminos_detectados.join(', '))}</li>`)}
   <h4>Señales detectadas</h4>${items(d.signals,t=>`<li><b>${esc(t.senal)}</b> — ${esc(t.terminos_detectados.join(', '))}</li>`)}
   <h4>Comparación con narrativas del proyecto activo</h4>${items(d.project_comparison,t=>`<li>${esc(t.tema)}: ${esc(t.registros_relacionados_por_palabras)} registros con vocabulario relacionado</li>`)}
   <h4>Acciones sugeridas para revisión humana</h4>${items(d.suggested_actions,t=>`<li>${esc(t)}</li>`)}
   <p><small>SHA-256 del texto: ${esc(d.evidence.sha256)} · ${esc(d.method)}</small></p>
   <div class="data-caveat">${esc(d.limitations.join(' '))}</div>`;
 }catch(e){target.textContent='No se pudo completar el análisis: '+e.message}
}


// RC 2.6: análisis digital enlazado a evidencia, con revisión humana separada de IRSA.
async function saveRC26Review(){
 const content=$('#rc24Text')?.value.trim()||'',link=$('#rc24Link')?.value.trim()||'';
 if(!content){toast('Texto requerido','Pegue el texto antes de guardar una señal.','error');return}
 if(link&&!cleanSocialLink(link)){toast('Enlace inválido','Debe usar una URL válida.','error');return}
 try{
  const data=await api('/system/intelligence/territorial-alerts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:content,source_url:link,project_id:activeProjectId,mode:$('#rc25Mode')?.value||'automatic',source_type:$('#rc26SourceType')?.value||'Publicación digital',analyst_note:$('#rc26AnalystNote')?.value||''})});
  toast('Señal registrada',data.id+' · pendiente de verificación');await loadRC26Reviews();
 }catch(e){toast('No se guardó',e.message,'error')}
}
async function loadRC26Reviews(){
 if(!$('#rc26ReviewList'))return;
 try{
  const [records,summary]=await Promise.all([api('/system/intelligence/territorial-alerts?project_id='+encodeURIComponent(activeProjectId)),api('/system/intelligence/territorial-summary?project_id='+encodeURIComponent(activeProjectId))]);
  $('#rc26Summary').innerHTML=[['Total',summary.total],['Pendientes',summary.by_status['Pendiente de verificación']||0],['Corroboradas',summary.by_status.Corroborado||0],['Prioridad alta',summary.by_priority.Alta||0]].map(([label,val])=>`<div class="territorial-kpi"><div><b>${val}</b><span>${esc(label)}</span></div></div>`).join('');
  $('#rc26ReviewList').innerHTML=records.length?`<table><thead><tr><th>Fecha</th><th>Fuente y evidencia</th><th>Temas</th><th>Prioridad</th><th>Estado</th><th>Revisión</th></tr></thead><tbody>${records.map(r=>`<tr><td>${esc(r.created_at.slice(0,16))}</td><td><b>${esc(r.source_type)}</b><div>${esc(r.excerpt.slice(0,120))}</div>${r.source_url&&cleanSocialLink(r.source_url)?`<a href="${esc(cleanSocialLink(r.source_url))}" target="_blank" rel="noopener noreferrer">Fuente ↗</a>`:''}<small>SHA-256: ${esc(r.sha256.slice(0,16))}…</small></td><td>${esc(r.themes.map(x=>x.tema).join(', ')||'Sin coincidencias')}</td><td>${esc(r.level)} · ${r.score}/100</td><td>${esc(r.status)}</td><td><select id="review-status-${esc(r.id)}"><option>${esc(r.status)}</option>${['Pendiente de verificación','Corroborado','Descartado','En seguimiento'].filter(x=>x!==r.status).map(x=>`<option>${x}</option>`).join('')}</select><input id="review-note-${esc(r.id)}" maxlength="2000" placeholder="Justificación de revisión"><button class="secondary" onclick="updateRC26Review(${jsq(r.id)})">Guardar revisión</button></td></tr>`).join('')}</tbody></table>`:'<p class="muted">No hay señales digitales registradas para este proyecto.</p>';
 }catch(e){$('#rc26ReviewList').textContent='No se pudieron cargar las alertas: '+e.message}
}
async function updateRC26Review(id){try{const status=$('#review-status-'+id)?.value,reviewer_note=$('#review-note-'+id)?.value||'';await api('/system/intelligence/territorial-alerts/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status,reviewer_note})});toast('Revisión actualizada','El IRSA permanece sin cambios.');await loadRC26Reviews();await loadRC27Actions()}catch(e){toast('Error de revisión',e.message,'error')}}


// RC 2.7 — Intervenciones vinculadas exclusivamente con alertas verificadas.
async function loadRC27Actions(){
 if(!$('#rc27Table'))return;
 try{
  const [actions,sum,alerts]=await Promise.all([
   api('/system/prevention/actions?project_id='+encodeURIComponent(activeProjectId)),
   api('/system/prevention/summary?project_id='+encodeURIComponent(activeProjectId)),
   api('/system/intelligence/territorial-alerts?project_id='+encodeURIComponent(activeProjectId))]);
  const valid=alerts.filter(x=>['Corroborado','En seguimiento'].includes(x.status));
  const select=$('#rc27Alert');const current=select.value;
  select.innerHTML='<option value="">Seleccione alerta validada...</option>'+valid.map(x=>`<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.level)} · ${esc(x.status)}</option>`).join('');
  if(valid.some(x=>x.id===current))select.value=current;
  $('#rc27Summary').innerHTML=[['Acciones',sum.total],['En curso',sum.active],['Vencidas',sum.overdue],['Completadas',sum.completed],['Cumplimiento',sum.completion_percent+'%']].map(([k,v])=>`<div class="territorial-kpi"><div><b>${esc(String(v))}</b><span>${esc(k)}</span></div></div>`).join('');
  $('#rc27Table').innerHTML=actions.length?`<table><thead><tr><th>Alerta / Acción</th><th>Responsable</th><th>Plazo</th><th>Estado y avance</th><th>Seguimiento</th></tr></thead><tbody>${actions.map(x=>`<tr><td><b>${esc(x.title)}</b><small>${esc(x.alert_id)}</small><div>${esc(x.description||'')}</div></td><td>${esc(x.responsible)}</td><td>${esc(x.due_date)}${x.due_date<new Date().toISOString().slice(0,10)&&!['Completada','Cancelada'].includes(x.status)?'<strong> · VENCIDA</strong>':''}</td><td>${esc(x.status)} · ${x.progress}%<small>${x.history.length} registro(s) de seguimiento</small></td><td><select id="rc27st-${esc(x.id)}">${['Pendiente','En ejecución','Completada','Cancelada'].map(t=>`<option ${t===x.status?'selected':''}>${t}</option>`).join('')}</select><input id="rc27pr-${esc(x.id)}" type="number" min="0" max="100" value="${x.progress}" aria-label="Avance porcentual"><textarea id="rc27nt-${esc(x.id)}" rows="2" placeholder="Actuación, resultado y justificación"></textarea><input id="rc27ev-${esc(x.id)}" type="url" placeholder="Enlace de evidencia (opcional)"><button class="secondary" onclick="updateRC27Action(${jsq(x.id)})">Guardar avance</button><details><summary>Historial</summary>${x.history.map(h=>`<p><small>${esc(h.created_at)} · ${esc(h.status)} · ${h.progress}%</small><div>${esc(h.note||'')}</div>${h.evidence_url?`<a href="${esc(h.evidence_url)}" target="_blank" rel="noopener noreferrer">Evidencia ↗</a>`:''}</p>`).join('')}</details></td></tr>`).join('')}</tbody></table>`:'<p class="muted">Aún no existen acciones preventivas en este proyecto.</p>';
 }catch(e){$('#rc27Table').textContent='No se pudo cargar el seguimiento: '+e.message}
}
async function createRC27Action(){
 const v=id=>$(id)?.value.trim()||'';
 const body={project_id:activeProjectId,alert_id:v('#rc27Alert'),title:v('#rc27Title'),responsible:v('#rc27Responsible'),due_date:v('#rc27Due'),description:v('#rc27Description')};
 if(!body.alert_id||!body.title||!body.responsible||!body.due_date){toast('Datos incompletos','Complete alerta, título, responsable y plazo.','error');return}
 try{const result=await api('/system/prevention/actions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Plan creado',result.action.id);await loadRC27Actions()}catch(e){toast('No se pudo crear',e.message,'error')}
}
async function updateRC27Action(id){
 const body={status:$('#rc27st-'+id).value,progress:Number($('#rc27pr-'+id).value),note:$('#rc27nt-'+id).value,evidence_url:$('#rc27ev-'+id).value.trim()};
 try{await api('/system/prevention/actions/'+encodeURIComponent(id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});toast('Avance registrado','Historial actualizado. IRSA permanece intacto.');await loadRC27Actions()}catch(e){toast('No se pudo actualizar',e.message,'error')}
}


// RC 2.8 — indicadores ejecutivos por proyecto; presentación sin confianza predictiva.
function rc28Table(headers,rows){if(!rows.length)return '<div class="empty-state">Sin registros para este proyecto.</div>';return '<table><thead><tr>'+headers.map(h=>'<th>'+esc(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell=>'<td>'+esc(cell)+'</td>').join('')+'</tr>').join('')+'</tbody></table>'}
function rc28Bars(target,obj){const entries=Object.entries(obj||{}),max=Math.max(1,...entries.map(x=>x[1]));$('#'+target).innerHTML=entries.length?entries.map(([name,value])=>'<div class="chart-row"><span>'+esc(name)+'</span><div class="chart-track"><i style="width:'+(100*value/max)+'%"></i></div><b>'+value+'</b></div>').join(''):'<p class="muted">Sin registros.</p>'}
async function loadRC28Management(){
  const d=await api('/system/management/overview?project_id='+encodeURIComponent(activeProjectId)),m=d.metrics;
  const data=[['Alertas digitales',m.digital_alerts],['Prioridad alta',m.high_priority_alerts],['Pendientes de verificar',m.pending_review],['Acciones activas',m.active_actions],['Acciones vencidas',m.overdue_actions],['Cumplimiento',m.completion_percent+'%'],['Compromisos registrados',m.registered_commitments],['Compromisos marcados vencidos',m.overdue_commitments_explicit]];
  $('#rc28Kpis').innerHTML=data.map(([name,val])=>'<div class="territorial-kpi"><div><b>'+esc(val)+'</b><span>'+esc(name)+'</span></div></div>').join('');
  rc28Bars('rc28Levels',d.alerts_by_level);rc28Bars('rc28Actions',d.actions_by_status);
  $('#rc28Critical').innerHTML=rc28Table(['Acción','Responsable','Plazo','Estado','Avance'],d.critical_actions.map(x=>[x.title,x.responsible,x.due_date,x.status,x.progress+'%']));
  $('#rc28Owners').innerHTML=rc28Table(['Responsable','Acciones','Vencidas'],d.actions_by_responsible.map(x=>[x.name,x.total,x.overdue]));
  $('#rc28Recent').innerHTML=rc28Table(['ID','Fecha','Prioridad','Verificación'],d.recent_alerts.map(x=>[x.id,x.created_at,x.level,x.status]));
}
function downloadRC28(){window.location.href='/system/management/report.csv?project_id='+encodeURIComponent(activeProjectId)}
