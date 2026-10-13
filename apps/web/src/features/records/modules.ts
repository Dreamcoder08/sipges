export type RecordModule =
  'eventos' | 'actores' | 'directorio' | 'demandas' | 'compromisos' | 'narrativas' | 'fuentes';
export type RecordField = {
  key: string;
  label: string;
  type?: 'date' | 'number' | 'textarea' | 'url' | 'tel';
  required?: boolean;
  options?: readonly string[];
  initial?: string;
  aliases?: readonly string[];
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
      { key: 'Rol/Relacion', label: 'Rol o relación' },
      { key: 'Influencia', label: 'Influencia', options: priority, initial: 'Media' },
      { key: 'Interes', label: 'Interés' },
      {
        key: 'Posicion_Proyecto',
        label: 'Posición frente al proyecto',
        options: ['A favor', 'Neutral', 'En contra', 'Por evaluar'],
        initial: 'Por evaluar',
      },
      source,
      notes,
    ],
  },
  directorio: {
    label: 'Directorio territorial',
    titleField: 'Nombre',
    columns: ['Nombre', 'Cargo', 'Institucion', 'Territorio', 'Telefono'],
    fields: [
      { key: 'Nombre', label: 'Nombre', required: true, aliases: ['Nombre actualizado 2026'] },
      { key: 'Cargo', label: 'Cargo' },
      { key: 'Institucion', label: 'Institución', aliases: ['Institución / Organización'] },
      { ...territory, aliases: ['Lugar / ámbito'] },
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
      { key: 'Plazo', label: 'Plazo' },
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
