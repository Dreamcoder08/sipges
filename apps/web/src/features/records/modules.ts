export type RecordModule =
  | 'eventos'
  | 'actores'
  | 'directorio'
  | 'demandas'
  | 'compromisos'
  | 'narrativas'
  | 'fuentes'
  | 'alertas'
  | 'acciones'
  | 'intereses'
  | 'dialogos'
  | 'oportunidades'
  | 'hechos'
  | 'aarc';
export type RecordField = {
  key: string;
  label: string;
  type?: 'date' | 'number' | 'textarea' | 'url' | 'tel';
  required?: boolean;
  options?: readonly string[];
  initial?: string;
  aliases?: readonly string[];
};
/** List filters by field value (the prototype's directory filters). */
export const FACETS: Partial<Record<RecordModule, readonly { key: string; label: string }[]>> = {
  directorio: [
    { key: 'Territorio', label: 'Territorio / ciudad' },
    { key: 'Tipo_Actor', label: 'Tipo de actor' },
    { key: 'Prioridad', label: 'Prioridad' },
  ],
};
export type ModuleDefinition = {
  label: string;
  fields: readonly RecordField[];
  columns: readonly string[];
  titleField: string;
};
const verification = [
  'A - Confirmada',
  'B - Corroborada',
  'C - Parcial',
  'D - Referencial',
  'E - No verificada',
];
const priority = ['Alta', 'Media', 'Baja'];
const dimension = [
  'G - Gobernanza y representación',
  'A - Actores e influencia',
  'D - Demandas y compromisos',
  'N - Narrativas y señales digitales',
  'E - Ambiental-territorial',
  'I - Institucional y trazabilidad',
];
const notes: RecordField = { key: 'Observaciones', label: 'Observaciones', type: 'textarea' };
const source: RecordField = { key: 'Fuente_ID', label: 'Referencia de fuente' };
const territory: RecordField = { key: 'Territorio', label: 'Territorio' };

export const MODULES: Record<RecordModule, ModuleDefinition> = {
  intereses: {
    label: 'Actores e intereses',
    titleField: 'Actor',
    columns: ['Actor', 'Posicion', 'Interes', 'Estado'],
    fields: [
      { key: 'Actor', label: 'Actor u organización', required: true },
      { key: 'Posicion', label: 'Posición expresada' },
      { key: 'Interes', label: 'Interés manifestado' },
      { key: 'Preocupacion', label: 'Preocupación o demanda' },
      { key: 'Mandato', label: 'Mandato o legitimidad documental' },
      { key: 'Alternativa', label: 'Alternativa ante la falta de acuerdo (BATNA)' },
      { key: 'Fuente_ID', label: 'Fuente o evidencia' },
      { key: 'Estado', label: 'Estado de verificación' },
    ],
  },
  dialogos: {
    label: 'Diálogo y construcción de consensos',
    titleField: 'Proceso',
    columns: ['Proceso', 'Participantes', 'Tema', 'Estado'],
    fields: [
      { key: 'Proceso', label: 'Nombre del proceso', required: true },
      { key: 'Participantes', label: 'Participantes' },
      { key: 'Tema', label: 'Temas y reglas de diálogo' },
      { key: 'Opciones', label: 'Opciones consideradas', type: 'textarea' },
      { key: 'Acuerdo', label: 'Acuerdo o desacuerdo', type: 'textarea' },
      { key: 'Responsable', label: 'Responsable' },
      { key: 'Proximo_Paso', label: 'Próximo paso y plazo' },
      { key: 'Fuente_ID', label: 'Acta o evidencia' },
      { key: 'Estado', label: 'Estado del proceso' },
    ],
  },
  oportunidades: {
    label: 'Valor compartido',
    titleField: 'Oportunidad',
    columns: ['Oportunidad', 'Tipo', 'Beneficiarios', 'Estado'],
    fields: [
      { key: 'Oportunidad', label: 'Oportunidad identificada', required: true },
      { key: 'Tipo', label: 'Tipo (empleo, proveedores, capacitación, servicios, etc.)' },
      { key: 'Beneficiarios', label: 'Posibles beneficiarios' },
      { key: 'Viabilidad', label: 'Condiciones de viabilidad' },
      { key: 'Restricciones', label: 'Restricciones técnicas/legales' },
      { key: 'Responsable', label: 'Responsable potencial' },
      { key: 'Plazo', label: 'Plazo referencial' },
      { key: 'Fuente_ID', label: 'Fuente o sustento' },
      { key: 'Estado', label: 'Estado (propuesta, en evaluación, aprobada, etc.)' },
    ],
  },
  hechos: {
    label: 'Hechos compartidos y verificación',
    titleField: 'Asunto',
    columns: ['Asunto', 'Versiones', 'Preguntas', 'Estado'],
    fields: [
      { key: 'Asunto', label: 'Pregunta o asunto por verificar', required: true },
      { key: 'Versiones', label: 'Versiones o información discrepante', type: 'textarea' },
      { key: 'Preguntas', label: 'Preguntas acordadas', type: 'textarea' },
      { key: 'Metodo', label: 'Método de contrastación', type: 'textarea' },
      { key: 'Participantes', label: 'Actores participantes' },
      { key: 'Fuente_ID', label: 'Fuentes o evidencia' },
      { key: 'Accion_Verificacion', label: 'Siguiente acción de verificación' },
      { key: 'Estado', label: 'Estado (pendiente, en contraste, validado, etc.)' },
    ],
  },
  aarc: {
    label: 'AARC · Calidad del relacionamiento',
    titleField: 'Actor_Proceso',
    columns: ['Actor_Proceso', 'Reconocimiento', 'Agencia', 'Estado'],
    fields: [
      { key: 'Actor_Proceso', label: 'Actor o proceso evaluado', required: true },
      { key: 'Reconocimiento', label: 'Reconocimiento de experiencias y preocupaciones' },
      { key: 'Agencia', label: 'Capacidad efectiva de participar e influir' },
      { key: 'Reciprocidad', label: 'Reciprocidad y opciones de valor mutuo' },
      { key: 'Claridad', label: 'Claridad de reglas, información y compromisos' },
      { key: 'Evidencia', label: 'Evidencia observable', type: 'textarea' },
      { key: 'Accion_Mejora', label: 'Acción de mejora' },
      { key: 'Fecha', label: 'Fecha de evaluación', type: 'date' },
      { key: 'Estado', label: 'Estado de revisión' },
    ],
  },
  alertas: {
    label: 'Alertas territoriales',
    titleField: 'Causa',
    columns: ['Fecha', 'Dimension', 'Causa', 'Nivel_Preliminar', 'Estado'],
    fields: [
      { key: 'Fecha', label: 'Fecha', type: 'date' },
      { key: 'Causa', label: 'Causa documentada', type: 'textarea', required: true },
      {
        ...territory,
        label: 'Comunidad / territorio',
        aliases: ['Comunidad', 'Localidad', 'Distrito'],
      },
      { key: 'Dimension', label: 'Dimensión', options: ['G', 'A', 'D', 'N', 'E', 'I'] },
      {
        key: 'Nivel_Preliminar',
        label: 'Nivel preliminar',
        options: ['Verde', 'Amarillo', 'Naranja', 'Rojo'],
        initial: 'Amarillo',
      },
      {
        key: 'Estado',
        label: 'Estado',
        options: ['Abierta', 'En seguimiento', 'Cerrada', 'Descartada'],
        initial: 'Abierta',
      },
      { key: 'Accion_Sugerida', label: 'Acción sugerida', type: 'textarea' },
      { key: 'Fuente_ID', label: 'Referencia de fuente' },
      { key: 'Observaciones', label: 'Observaciones', type: 'textarea' },
    ],
  },
  acciones: {
    label: 'Acciones territoriales',
    titleField: 'Accion',
    columns: ['Accion', 'Responsable', 'Plazo', 'Estado'],
    fields: [
      { key: 'Accion', label: 'Acción documentada', type: 'textarea', required: true },
      { key: 'Alerta_Asociada', label: 'Alerta asociada' },
      { key: 'Responsable', label: 'Responsable' },
      { key: 'Plazo', label: 'Plazo documentado' },
      {
        key: 'Fecha_Vencimiento',
        aliases: ['Fecha_Limite'],
        label: 'Fecha límite',
        type: 'date',
        initial: '',
      },
      {
        key: 'Estado',
        label: 'Estado',
        options: ['Pendiente', 'En proceso', 'Cumplida', 'Cancelada'],
        initial: 'Pendiente',
      },
      { key: 'Fuente_ID', label: 'Referencia de fuente' },
      { key: 'Observaciones', label: 'Observaciones', type: 'textarea' },
    ],
  },
  eventos: {
    label: 'Eventos',
    titleField: 'Descripcion_Hecho',
    columns: [
      'Fecha',
      'Descripcion_Hecho',
      'Territorio',
      'Dimension_Principal',
      'Nivel_Verificacion',
    ],
    fields: [
      { key: 'Fecha', label: 'Fecha', type: 'date' },
      territory,
      { key: 'Actor_Principal', label: 'Actor principal' },
      { key: 'Tipo_Evento', label: 'Tipo de evento' },
      {
        key: 'Descripcion_Hecho',
        label: 'Descripción del hecho',
        type: 'textarea',
        required: true,
      },
      { key: 'Dimension_Principal', label: 'Dimensión principal', options: dimension },
      {
        key: 'Relevancia_Preliminar',
        label: 'Relevancia preliminar',
        options: priority,
        initial: 'Media',
      },
      {
        key: 'Nivel_Verificacion',
        label: 'Verificación',
        options: verification,
        initial: 'E - No verificada',
      },
      {
        key: 'Estado_Validacion',
        label: 'Estado de validación',
        options: ['Preliminar', 'En revisión', 'Validado'],
        initial: 'Preliminar',
      },
      source,
      notes,
    ],
  },
  actores: {
    label: 'Actores',
    titleField: 'Nombre_Actor/Organizacion',
    columns: [
      'Nombre_Actor/Organizacion',
      'Tipo_Actor',
      'Territorio',
      'Influencia',
      'Posicion_Proyecto',
    ],
    fields: [
      {
        key: 'Nombre_Actor/Organizacion',
        label: 'Nombre del actor u organización',
        required: true,
      },
      {
        key: 'Tipo_Actor',
        label: 'Tipo de actor',
        options: [
          'Comunidad',
          'Organización social',
          'Empresa',
          'Institución pública',
          'Otro / por verificar',
        ],
      },
      territory,
      {
        key: 'Sector',
        label: 'Sector en el mapa de actores',
        options: ['Gobierno', 'Privado', 'Academia', 'Sociedad civil'],
      },
      { key: 'Rol/Relacion', label: 'Rol o relación' },
      {
        key: 'Influencia',
        label: 'Influencia',
        options: ['Alta', 'Media-alta', 'Media', 'Media-baja', 'Baja'],
      },
      { key: 'Interes', label: 'Interés' },
      {
        key: 'Posicion_Proyecto',
        label: 'Posición frente al proyecto',
        options: ['A favor', 'Neutral', 'En contra', 'Por evaluar'],
        initial: 'Por evaluar',
      },
      { key: 'Tipo_Relacion', label: 'Tipo de relación', options: ['Fuerte', 'Débil'] },
      {
        key: 'Sentido_Relacion',
        label: 'Sentido de la relación',
        options: ['Del proyecto al actor', 'Del actor al proyecto', 'De ambos'],
      },
      source,
      notes,
    ],
  },
  directorio: {
    label: 'Directorio territorial',
    titleField: 'Nombre',
    columns: ['Nombre', 'Cargo', 'Institucion', 'Territorio', 'Telefono', 'Prioridad'],
    fields: [
      { key: 'Nombre', label: 'Nombre', required: true, aliases: ['Nombre actualizado 2026'] },
      { key: 'Cargo', label: 'Cargo', aliases: ['Cargo actual'] },
      { key: 'Institucion', label: 'Institución', aliases: ['Institución / Organización'] },
      {
        ...territory,
        label: 'Territorio / ciudad',
        aliases: ['Lugar / ámbito', 'Ciudad', 'Distrito', 'Localidad'],
      },
      {
        key: 'Telefono',
        label: 'Teléfono',
        type: 'tel',
        aliases: ['Celular', 'Número de contacto', 'Número de celular', 'Telefono / celular'],
      },
      { key: 'Tipo_Actor', label: 'Tipo de actor', aliases: ['Tipo de actor MASCLI'] },
      {
        key: 'Prioridad',
        label: 'Prioridad',
        options: priority,
        aliases: ['Prioridad MASCLI propuesta'],
      },
      {
        key: 'Estado_Verificacion',
        label: 'Verificación',
        options: ['Por verificar', 'Actualizado por fuente', 'Corroborado'],
        initial: 'Por verificar',
        aliases: ['Estado de verificación'],
      },
      source,
      notes,
    ],
  },
  demandas: {
    label: 'Demandas',
    titleField: 'Descripcion',
    columns: ['Fecha_Registro', 'Descripcion', 'Actor/Grupo', 'Prioridad', 'Estado'],
    fields: [
      { key: 'Fecha_Registro', label: 'Fecha de registro', type: 'date' },
      { key: 'Actor/Grupo', label: 'Actor o grupo' },
      territory,
      { key: 'Tema', label: 'Tema' },
      { key: 'Descripcion', label: 'Descripción', type: 'textarea', required: true },
      { key: 'Prioridad', label: 'Prioridad', options: priority, initial: 'Media' },
      {
        key: 'Estado',
        label: 'Estado',
        options: ['Nueva', 'En revisión', 'En diálogo', 'Atendida', 'Cerrada'],
        initial: 'Nueva',
      },
      source,
      notes,
    ],
  },
  compromisos: {
    label: 'Compromisos',
    titleField: 'Descripcion',
    columns: ['Fecha', 'Descripcion', 'Responsable', 'Plazo', 'Estado'],
    fields: [
      { key: 'Fecha', label: 'Fecha', type: 'date' },
      { key: 'Descripcion', label: 'Descripción', type: 'textarea', required: true },
      { key: 'Actor/Entidad', label: 'Actor o entidad' },
      { key: 'Demanda_Asociada', label: 'Demanda asociada' },
      { key: 'Responsable', label: 'Responsable' },
      { key: 'Plazo', label: 'Plazo documentado' },
      {
        key: 'Fecha_Vencimiento',
        aliases: ['Fecha_Limite'],
        label: 'Fecha límite',
        type: 'date',
        initial: '',
      },
      { key: 'Avance_%', label: 'Avance (%)', type: 'number', initial: '0' },
      {
        key: 'Estado',
        label: 'Estado',
        options: ['Pendiente', 'En proceso', 'Cumplido', 'Incumplido'],
        initial: 'Pendiente',
      },
      { key: 'Evidencia_Cierre', label: 'Evidencia de cierre' },
      source,
      notes,
    ],
  },
  narrativas: {
    label: 'Narrativas',
    titleField: 'Descripcion',
    columns: ['Fecha_Inicio', 'Descripcion', 'Plataforma/Fuente', 'Tema', 'Nivel_Verificacion'],
    fields: [
      { key: 'Fecha_Inicio', label: 'Fecha de publicación', type: 'date' },
      { key: 'Fecha_Observacion', label: 'Fecha de observación', type: 'date' },
      { key: 'URL_Publicacion', label: 'Enlace de la publicación', type: 'url' },
      { key: 'Plataforma/Fuente', label: 'Plataforma o fuente' },
      { key: 'Tema', label: 'Tema' },
      { key: 'Categoria', label: 'Categoría', options: dimension },
      { key: 'Actor_Relacionado', label: 'Actor relacionado' },
      {
        key: 'Interacciones_Observadas',
        label: 'Interacciones observadas',
        type: 'number',
        initial: '0',
      },
      { key: 'Descripcion', label: 'Descripción', type: 'textarea', required: true },
      {
        key: 'Tono',
        label: 'Tono',
        options: ['Neutral', 'Positivo', 'Crítico', 'Por evaluar'],
        initial: 'Por evaluar',
      },
      { key: 'Intensidad', label: 'Intensidad', options: priority, initial: 'Media' },
      {
        key: 'Nivel_Verificacion',
        label: 'Verificación',
        options: verification,
        initial: 'E - No verificada',
      },
      {
        key: 'Estado',
        label: 'Estado',
        options: ['Abierta', 'En seguimiento', 'Cerrada'],
        initial: 'Abierta',
      },
      source,
      notes,
    ],
  },
  fuentes: {
    label: 'Fuentes',
    titleField: 'Archivo_Fuente',
    columns: [
      'Fecha_Documento',
      'Archivo_Fuente',
      'Tipo_Fuente',
      'Institucion/Autor',
      'Nivel_Base_Verificacion',
    ],
    fields: [
      { key: 'Fecha_Documento', label: 'Fecha del documento', type: 'date' },
      { key: 'Archivo_Fuente', label: 'Nombre de la fuente o documento', required: true },
      {
        key: 'Tipo_Fuente',
        label: 'Tipo de fuente',
        options: ['Reporte / evidencia', 'Acta', 'Informe', 'Documento institucional', 'Otro'],
      },
      { key: 'Institucion/Autor', label: 'Institución o autor' },
      { key: 'Periodo_Cubierto', label: 'Periodo cubierto' },
      {
        key: 'Nivel_Base_Verificacion',
        label: 'Verificación',
        options: verification,
        initial: 'E - No verificada',
      },
      notes,
    ],
  },
};
