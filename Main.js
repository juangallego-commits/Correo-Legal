/**
 * ============================================================================
 * LEGAL OPS MASTER — Módulo Laboral — V1.2 (MVP Fase 1 + extracción)
 * ============================================================================
 *
 * Reenvía automáticamente correos de procesos laborales desde la bandeja
 * notificacionesrappi@rappi.com hacia Godoy (firma externa) + equipo legal
 * interno. Adicionalmente, lee el PDF del auto admisorio y carga los datos
 * del proceso en un Spreadsheet aparte (Procesos Laborales).
 *
 * APLICA TODAS LAS LECCIONES DE V16.0 SAFE MODE:
 *  - Filtro de tiempo: solo correos de las últimas 48h (newer_than:2d)
 *  - Anti-bucle: tracking de Message-ID en hoja de control
 *  - Marcado seguro: try/catch en etiquetas, marca leído/archiva SIEMPRE
 *  - Cuerpo original preservado: htmlBody = nota + msg.getBody()
 *  - Doble validación por Message-ID antes de procesar
 *
 * CAMBIOS V1.2 (sobre V1.1):
 *  - Nuevo módulo de extracción de procesos: para cada correo laboral, el bot
 *    intenta leer el PDF adjunto (OCR vía Drive API v2), extraer los campos
 *    con regex y, si faltan campos críticos, completar con Gemini API. Carga
 *    los datos en un Spreadsheet aparte con la misma estructura de 29 columnas
 *    que "Procesos Laborales Repartidores".
 *  - Upsert seguro: si el radicado ya existe, solo rellena celdas vacías —
 *    nunca pisa ediciones manuales de Nicolas/Isabela.
 *  - En DRY_RUN escribe en pestaña aparte (BOT_DRY_Procesos) del mismo Spreadsheet
 *    para validar la calidad de extracción sin contaminar producción.
 *  - La extracción es best-effort: cualquier fallo se loguea pero no bloquea
 *    el reenvío al equipo legal, que es la función crítica del bot.
 *
 * CAMBIOS V1.1 (sobre V1.0):
 *  - En DRY_RUN, los correos clasificados como laboral o ambiguo se etiquetan
 *    con BOT/DRY-Laboral o BOT/DRY-Ambiguo. Permite auditar la clasificación
 *    directamente en Gmail sin abrir el sheet.
 *  - La hoja de control BOT_CONTROL_LABORAL ahora separa los universos prueba
 *    y producción. Anotaciones hechas en DRY_RUN no bloquean el reenvío real
 *    cuando se active producción.
 *
 * INSTALACIÓN:
 *  1. Abrir script.google.com CON TU CUENTA PERSONAL (juan.gallego@rappi.com).
 *     El bot puede correr bajo tu cuenta mientras notificacionesrappi@rappi.com
 *     esté configurado como alias "Send mail as" en tu Gmail.
 *  2. Verificar el alias: Gmail → Settings → Accounts and Import → "Send mail as".
 *     Debe aparecer notificacionesrappi@rappi.com. Si no, configúralo antes de seguir.
 *  3. Crear nuevo proyecto → pegar este código.
 *  4. Autorizar scopes (Gmail + Sheets) al correr primera vez.
 *  5. Ejecutar testManual() y revisar BOT_LOG_LABORAL en la matriz.
 *  6. Si el log muestra "Alias de envío NO configurado" → arreglar antes de seguir.
 *  7. Verificar 2-3 días con DRY_RUN=true. Cuando todo se vea bien:
 *     - Cambiar DRY_RUN a false
 *     - Ejecutar setupTrigger() una sola vez para instalar el cron de 15 min
 *
 * SETUP ADICIONAL PARA EL MÓDULO DE EXTRACCIÓN (V1.2):
 *  8. Crear un Spreadsheet nuevo (vacío). Anotar su ID y pegarlo en
 *     CONFIG.PROCESOS.SPREADSHEET_ID. El bot creará las pestañas necesarias.
 *  9. Generar API key en Google AI Studio (https://aistudio.google.com) y
 *     pegarla como Script Property: Project Settings → Script Properties →
 *     Add → name: GEMINI_API_KEY.
 * 10. Habilitar Drive API v2 como advanced service: Services → Add →
 *     Drive API → seleccionar v2 → Add.
 * 11. Verificar con testExtraccionMensaje(messageId) sobre un correo laboral
 *     real antes de activar producción.
 * ============================================================================
 */


// ============================================================================
// CONFIGURACIÓN
// ============================================================================

const CONFIG = {
  // --- MODO DE OPERACIÓN ---
  // true = simula el reenvío y loguea qué haría, pero NO envía nada.
  // false = reenvía de verdad. SOLO cambiar después de validar en dry run.
  DRY_RUN: true,

  // --- HOJA DE CÁLCULO (Matriz Laboral existente) ---
  MATRIX_ID: '1m4T6GNdwDu-3Hb2a53lrGJ1p9wNoY9exTIDdTsq1PTo',
  LOG_SHEET_NAME: 'BOT_LOG_LABORAL',
  CONTROL_SHEET_NAME: 'BOT_CONTROL_LABORAL',

  // --- DESTINATARIOS DEL REENVÍO ---
  RECIPIENTS: [
    'litigios4@godoy.legal',
    'fbernal@godoy.legal',
    'legalcolombia@rappi.com'
  ],

  // --- IDENTIDAD DEL REMITENTE (alias "Send mail as") ---
  // Si se define, los reenvíos salen "desde" este correo, aunque el script
  // corra bajo tu cuenta personal. Requiere que el alias esté configurado en
  // tu Gmail → Settings → Accounts → "Send mail as".
  // Si es null, los forwards salen desde la cuenta que ejecuta el script.
  SEND_AS_ALIAS: 'notificacionesrappi@rappi.com',

  // --- CLASIFICACIÓN: CAPA 1 — ALTA CONFIANZA ---
  // Remitentes cuya sola presencia confirma que es laboral.
  // TODO Nicolas/Fabio: completar con correos de firmas demandantes.
  FIRMAS_LABORALES: [
    // 'quinteropalacios.com',       // Quintero Palacios (dominio, por ejemplo)
    // 'laterfirma.com',             // La "ter" firma
    // agregar más a medida que se identifiquen
  ],

  // --- CLASIFICACIÓN: CAPA 2 — CONFIANZA MEDIA ---
  // Dominios judiciales — sí son notificaciones legales, pero pueden
  // ser laborales o de otra jurisdicción. Requieren verificar keywords.
  DOMINIOS_JUDICIALES: [
    'ramajudicial.gov.co',
    'deaj.ramajudicial.gov.co'
  ],

  // Keywords que, combinadas con dominio judicial, confirman laboral.
  KEYWORDS_LABORAL: [
    'proceso ordinario laboral',
    'juzgado laboral',
    'juzgado municipal de pequeñas causas laborales',
    'demanda laboral',
    'contrato realidad',
    'reintegro',
    'solidaridad laboral',
    'acreencias laborales',
    'prestaciones sociales',
    'auto admisorio'  // no es solo laboral, pero combinado con dominio judicial sube confianza
  ],

  // --- CONTROL DEL SCAN ---
  // Excluimos labels propias para que threads ya procesados/marcados no
  // vuelvan a aparecer en la query (capa extra anti-bucle, además del
  // tracking por Message-ID).
  SEARCH_QUERY: 'in:inbox is:unread newer_than:2d ' +
    '-label:BOT/Laboral-Procesado -label:BOT/Laboral-Revisar ' +
    '-label:BOT/DRY-Laboral -label:BOT/DRY-Ambiguo',
  MAX_THREADS_PER_RUN: 50,

  // Cuántas filas finales leer del control sheet para chequear duplicados.
  // Buffer holgado: 2000 filas cubren semanas de actividad y la query Gmail
  // ya filtra por newer_than:2d. Evita cargar toda la hoja en memoria.
  CONTROL_SHEET_LOOKBACK: 2000,

  // --- ETIQUETAS DE GMAIL ---
  // Producción: se aplican cuando DRY_RUN = false
  LABEL_PROCESADO: 'BOT/Laboral-Procesado',
  LABEL_AMBIGUO: 'BOT/Laboral-Revisar',
  // Prueba: se aplican cuando DRY_RUN = true. Permiten ver la clasificación
  // directamente en Gmail sin contaminar las etiquetas de producción.
  // Para limpiar después de las pruebas: borrar estas dos labels desde Gmail
  // (se quitan de todos los correos automáticamente).
  LABEL_DRY_LABORAL: 'BOT/DRY-Laboral',
  LABEL_DRY_AMBIGUO: 'BOT/DRY-Ambiguo',

  // --- EXTRACCIÓN DE PROCESOS A SHEET NUEVO ---
  // Cuando un correo se clasifica como laboral, además de reenviarlo se intenta
  // leer el PDF del auto admisorio, extraer los campos del proceso (radicado,
  // juzgado, demandante, etc.) y cargarlos en un Spreadsheet aparte que imita
  // la estructura de "Procesos Laborales Repartidores".
  //
  // SETUP MANUAL (one-time):
  //  1. Crear un Spreadsheet nuevo (no la matriz). Anotar su ID y pegarlo en
  //     PROCESOS.SPREADSHEET_ID. El bot creará las pestañas necesarias.
  //  2. En Google AI Studio (https://aistudio.google.com) generar una API key
  //     de Gemini y pegarla como Script Property:
  //     Project Settings → Script Properties → Add → name: GEMINI_API_KEY.
  //  3. Habilitar Drive API v2 como advanced service:
  //     Services → Add → Drive API → versión v2.
  PROCESOS: {
    SPREADSHEET_ID: '1isRib51rcK6iLtU5ppJTD7cayjwcFTe7SSxRboMVKIM',
    SHEET_NAME: 'Procesos Laborales',
    SHEET_NAME_DRY: 'BOT_DRY_Procesos',
    PENDIENTES_SHEET_NAME: 'BOT_EXTRACCION_PENDIENTE',
    EXTRAER: true,                            // master switch del módulo
    USAR_GEMINI_FALLBACK: true,
    GEMINI_MODEL: 'gemini-2.0-flash',
    GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models/',
    GEMINI_TIMEOUT_MS: 20000,
    GEMINI_MAX_RETRIES: 1,
    PDF_MAX_BYTES: 15 * 1024 * 1024,          // 15 MB cap por adjunto
    CAMPOS_CRITICOS: ['radicado', 'juzgado', 'demandante'],
    TEXTO_OCR_MAX_CHARS: 15000,               // truncar antes de Gemini

    // Headers exactos del sheet original "Procesos Laborales Repartidores".
    // 29 columnas A..AC. NO cambiar el orden — upsertProcesoEnSheet asume
    // este orden para mapear los campos extraídos a celdas.
    HEADERS: [
      ' ',                                          // A
      'Link carpeta',                               // B
      'Número de Radicado',                         // C
      'Tipo de acción',                             // D
      'Juzgado',                                    // E
      'Tendencia del Juzgado',                      // F
      'Ciudad',                                     // G
      'Demandante',                                 // H
      'ID Soy Rappi',                               // I
      'Es Rayo actualmente?',                       // J
      '¿Ha sido Rayo?',                             // K
      'Responsable ED/CD',                          // L
      'Estado Actual',                              // M
      'Fecha notificación del auto admisorio de la demanda',  // N
      'Fecha de audiencia',                         // O
      'Hora y articulos de la audiencia ',          // P
      'Fecha conciliación',                         // Q
      'Valor Conciliación',                         // R
      'Valor Pretensión',                           // S
      'Fecha de otorgación del poder',              // T
      'Honorarios Godoy',                           // U
      'Pendiente Facturación Godoy',                // V
      'Tipo de caso',                               // W
      'Ganancias totales',                          // X
      'Última actuación',                           // Y
      'Resumen del caso ',                          // Z
      'Mes radicado',                               // AA
      'Mes conciliado',                             // AB
      'Diff radicado y conciliado'                  // AC
    ],
  },
};


// ============================================================================
// ENTRY POINT — ejecutado por el trigger cada 15 minutos
// ============================================================================

function procesarCorreosLaborales() {
  // Lock para evitar que dos triggers se solapen y procesen el mismo mensaje
  // (puede pasar si una corrida tarda más de 15 min). Si no logramos el lock
  // en 30s, abortamos: la próxima corrida lo tomará.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    console.log('[INFO] Otra corrida en curso. Abortando.');
    return;
  }

  const startTime = new Date();
  logBot('INFO', 'Inicio de corrida', `DRY_RUN=${CONFIG.DRY_RUN}`);

  // Validación dura: si el alias de envío está configurado pero no existe en
  // los aliases del usuario, detenemos la corrida. Prefiero que nada salga
  // a que salga con una identidad incorrecta.
  if (!validarAliasConfigurado()) {
    lock.releaseLock();
    return;
  }

  // Validación suave: si el módulo de extracción está activo, avisar (no
  // bloquear) sobre configuración faltante. El forward sigue funcionando aun
  // si la extracción no puede correr.
  if (CONFIG.PROCESOS.EXTRAER) {
    validarExtraccionConfigurada();
  }

  try {
    const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, CONFIG.MAX_THREADS_PER_RUN);
    logBot('INFO', `Threads encontrados: ${threads.length}`, '');

    const processedIds = getProcessedMessageIds();

    let stats = { laboral: 0, ambiguo: 0, no_laboral: 0, ya_procesado: 0, error: 0 };

    for (const thread of threads) {
      const messages = thread.getMessages();
      for (const msg of messages) {
        // La query devuelve threads con AL MENOS un mensaje unread, pero
        // thread.getMessages() trae todos los mensajes del hilo. Saltamos
        // los ya leídos para no reprocesar respuestas viejas.
        if (!msg.isUnread()) continue;
        try {
          const resultado = procesarMensaje(msg, processedIds);
          stats[resultado] = (stats[resultado] || 0) + 1;
        } catch (e) {
          stats.error++;
          logBot('ERROR', 'Fallo procesando mensaje', `${msg.getId()} → ${e.message}`);
        }
      }
    }

    const duracion = ((new Date() - startTime) / 1000).toFixed(1);
    logBot('INFO', 'Fin de corrida',
      `${duracion}s | laboral:${stats.laboral} ambiguo:${stats.ambiguo} no_laboral:${stats.no_laboral} ya_procesado:${stats.ya_procesado} error:${stats.error}`);

  } catch (e) {
    logBot('ERROR', 'Fallo general en la corrida', e.message);
  } finally {
    lock.releaseLock();
  }
}


// ============================================================================
// PROCESAMIENTO INDIVIDUAL
// ============================================================================

function procesarMensaje(msg, processedIds) {
  const messageId = msg.getId();

  // Anti-bucle: ya procesado en corrida previa?
  if (processedIds.has(messageId)) {
    return 'ya_procesado';
  }

  // Clasificar
  const clasificacion = clasificarComoLaboral(msg);

  if (clasificacion.decision === 'no_laboral') {
    // No hacemos nada: no lo marcamos como procesado, no lo tocamos.
    // Otro módulo (tutelas, DDPP, etc.) se encargará en el futuro.
    return 'no_laboral';
  }

  if (clasificacion.decision === 'ambiguo') {
    // No actuamos automáticamente. Lo flaggeamos para revisión humana.
    logBot('AMBIGUO', 'Requiere revisión humana',
      `${msg.getFrom()} | ${msg.getSubject()} | razon=${clasificacion.razon}`);
    try {
      // En prueba usamos label DRY para no contaminar producción
      const nombreLabel = CONFIG.DRY_RUN ? CONFIG.LABEL_DRY_AMBIGUO : CONFIG.LABEL_AMBIGUO;
      const label = getOrCreateLabel(nombreLabel);
      msg.getThread().addLabel(label);
    } catch (e) {
      // No crítico. Seguimos.
    }
    // Registramos el ambiguo para no volver a loguearlo en cada corrida.
    // Permanece unread/sin archivar — el humano lo gestiona en Gmail.
    registrarProcesado(messageId, msg, clasificacion);
    processedIds.add(messageId);
    return 'ambiguo';
  }

  // Es laboral → reenviar (o solo etiquetar, en prueba)
  if (CONFIG.DRY_RUN) {
    logBot('DRY_RUN', 'Reenvío simulado (no enviado)',
      `${msg.getFrom()} | ${msg.getSubject()} | razon=${clasificacion.razon} | conf=${clasificacion.confianza}`);
    // En prueba etiquetamos el correo (para verlo en Gmail) pero NO marcamos
    // leído ni archivamos. El correo queda intacto en la bandeja.
    try {
      const label = getOrCreateLabel(CONFIG.LABEL_DRY_LABORAL);
      msg.getThread().addLabel(label);
    } catch (e) {
      // No crítico. Seguimos.
    }
  } else {
    reenviarSeguro(msg, clasificacion);
    marcarYArchivarSeguro(msg);
    logBot('OK', 'Reenviado',
      `${msg.getFrom()} | ${msg.getSubject()} | razon=${clasificacion.razon}`);
  }

  // Enriquecimiento best-effort: leer el PDF del auto admisorio y cargar el
  // proceso en el sheet aparte. NUNCA debe bloquear el flujo del reenvío:
  // si esto falla, el correo ya quedó reenviado/etiquetado correctamente.
  if (CONFIG.PROCESOS.EXTRAER) {
    try {
      extraerYUpsertProceso(msg, clasificacion);
    } catch (e) {
      logBot('WARN', 'Extracción de proceso falló (no bloquea forward)',
        `${messageId} → ${e.message}`);
    }
  }

  registrarProcesado(messageId, msg, clasificacion);
  processedIds.add(messageId);  // actualiza cache en memoria para esta corrida

  return 'laboral';
}


// ============================================================================
// CLASIFICADOR
// ============================================================================

function clasificarComoLaboral(msg) {
  const fromEmail = extractEmail(msg.getFrom());
  const subject = (msg.getSubject() || '').toLowerCase();

  // Sample primeros 5000 chars del cuerpo plano (evita gastar memoria/tiempo en correos gigantes)
  const body = (msg.getPlainBody() || '').toLowerCase().slice(0, 5000);

  // --- CAPA 1: Remitente en whitelist de firmas laborales ---
  for (const firma of CONFIG.FIRMAS_LABORALES) {
    if (fromEmail.includes(firma.toLowerCase())) {
      return { decision: 'laboral', razon: 'firma_laboral_whitelist', confianza: 0.95 };
    }
  }

  // --- CAPA 2: Dominio judicial (SIUGJ / juzgados) ---
  const esDominioJudicial = CONFIG.DOMINIOS_JUDICIALES.some(d => fromEmail.includes(d));

  if (esDominioJudicial) {
    const matches = CONFIG.KEYWORDS_LABORAL.filter(k =>
      subject.includes(k) || body.includes(k)
    );

    if (matches.length >= 2) {
      return {
        decision: 'laboral',
        razon: `dominio_judicial + ${matches.length} keywords (${matches.slice(0, 3).join(', ')})`,
        confianza: 0.85
      };
    }

    if (matches.length === 1) {
      // Solo 1 keyword → ambiguo. Mejor que Nicolas lo mire.
      return {
        decision: 'ambiguo',
        razon: `dominio_judicial + 1 keyword (${matches[0]})`,
        confianza: 0.55
      };
    }

    // Dominio judicial sin keywords laborales → probablemente otra jurisdicción (civil, tutela, etc.)
    return {
      decision: 'ambiguo',
      razon: 'dominio_judicial_sin_keywords_laborales',
      confianza: 0.3
    };
  }

  // --- CAPA 3: Remitente desconocido con keywords muy fuertes ---
  const strongKeywords = ['proceso ordinario laboral', 'juzgado laboral', 'contrato realidad'];
  const strongMatches = strongKeywords.filter(k => subject.includes(k) || body.includes(k));
  if (strongMatches.length > 0) {
    return {
      decision: 'ambiguo',
      razon: `remitente_desconocido + keyword_fuerte (${strongMatches[0]})`,
      confianza: 0.5
    };
  }

  return { decision: 'no_laboral', razon: 'sin_matches', confianza: 0 };
}


// ============================================================================
// REENVÍO SEGURO
// ============================================================================

function reenviarSeguro(msg, clasificacion) {
  const recipients = CONFIG.RECIPIENTS.join(',');

  const nota = `
    <div style="background:#f5f5f5; border-left:3px solid #0066cc; padding:10px; margin-bottom:16px; font-family:Arial,sans-serif; font-size:13px; color:#333;">
      <b>Equipo, FYI</b> — reenvío automático de notificación laboral.<br>
      <span style="color:#666; font-size:11px;">
        Bot Legal Ops · clasificación: ${clasificacion.razon} · confianza: ${clasificacion.confianza}
      </span>
    </div>
    <hr style="border:none; border-top:1px solid #ddd;">
  `;

  const options = {
    htmlBody: nota + msg.getBody(),
    attachments: msg.getAttachments()
  };

  // Reenviar CON la identidad del alias configurado (si lo hay),
  // para que el correo salga desde notificacionesrappi@rappi.com y no
  // desde la cuenta personal que ejecuta el script.
  if (CONFIG.SEND_AS_ALIAS) {
    options.from = CONFIG.SEND_AS_ALIAS;
  }

  // msg.forward() con htmlBody reemplaza el cuerpo → usamos nota + cuerpo ORIGINAL
  msg.forward(recipients, options);
}


// ============================================================================
// MARCADO Y ARCHIVO SEGURO (patrón V16.0)
// ============================================================================

function marcarYArchivarSeguro(msg) {
  // La etiqueta NO es crítica. Si falla, no detenemos el flujo.
  try {
    const label = getOrCreateLabel(CONFIG.LABEL_PROCESADO);
    msg.getThread().addLabel(label);
  } catch (e) {
    logBot('WARN', 'No se pudo aplicar label (ignorado)', e.message);
  }

  // Marcar leído y archivar SON críticos para evitar bucles.
  // Van por separado en try's individuales para que una falla no bloquee la otra.
  try { msg.markRead(); } catch (e) { logBot('WARN', 'markRead falló', e.message); }
  try { msg.getThread().moveToArchive(); } catch (e) { logBot('WARN', 'archive falló', e.message); }
}


// ============================================================================
// STORAGE (hojas de control y log)
// ============================================================================

function getProcessedMessageIds() {
  const sheet = getOrCreateSheet(CONFIG.CONTROL_SHEET_NAME,
    ['MessageID', 'Timestamp', 'From', 'Subject', 'Clasificación', 'Confianza', 'DryRun']);

  // Solo leemos las últimas N filas. La query Gmail filtra por newer_than:2d,
  // así que un buffer de varios días de historial es más que suficiente para
  // detectar duplicados sin cargar toda la hoja en memoria.
  const lastRow = sheet.getLastRow();
  const ids = new Set();
  if (lastRow < 2) return ids;

  const startRow = Math.max(2, lastRow - CONFIG.CONTROL_SHEET_LOOKBACK + 1);
  const numRows = lastRow - startRow + 1;
  const data = sheet.getRange(startRow, 1, numRows, 7).getValues();

  // CLAVE: separamos los dos universos. En modo prueba solo "vemos" las anotaciones
  // de prueba; en producción solo "vemos" las reales. Así las pruebas no bloquean
  // los reenvíos cuando se active producción, y producción no se confunde con
  // anotaciones de prueba viejas.
  // Columnas: 0=MessageID, 1=Timestamp, 2=From, 3=Subject, 4=Clasificación, 5=Confianza, 6=DryRun
  for (let i = 0; i < data.length; i++) {
    const id = data[i][0];
    const valDryRun = data[i][6];
    const fueDryRun = valDryRun === true || valDryRun === 'TRUE' || valDryRun === 'true';
    if (id && fueDryRun === CONFIG.DRY_RUN) {
      ids.add(id.toString());
    }
  }
  return ids;
}

function registrarProcesado(messageId, msg, clasificacion) {
  const sheet = getOrCreateSheet(CONFIG.CONTROL_SHEET_NAME,
    ['MessageID', 'Timestamp', 'From', 'Subject', 'Clasificación', 'Confianza', 'DryRun']);
  sheet.appendRow([
    messageId,
    new Date(),
    msg.getFrom(),
    msg.getSubject(),
    clasificacion.razon,
    clasificacion.confianza,
    CONFIG.DRY_RUN
  ]);
}

function logBot(level, mensaje, detalle) {
  try {
    const sheet = getOrCreateSheet(CONFIG.LOG_SHEET_NAME,
      ['Timestamp', 'Level', 'Mensaje', 'Detalle']);
    sheet.appendRow([new Date(), level, mensaje, detalle]);
  } catch (e) {
    // Si el log falla, al menos imprimimos en consola
    console.error(`LOG FALLÓ: ${level} | ${mensaje} | ${detalle} | err: ${e.message}`);
  }
  console.log(`[${level}] ${mensaje} | ${detalle}`);
}

function getOrCreateSheet(name, headers, spreadsheetId) {
  const ss = SpreadsheetApp.openById(spreadsheetId || CONFIG.MATRIX_ID);
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) {
      sheet.appendRow(headers);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#e8eaed');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}


// ============================================================================
// UTILS
// ============================================================================

function extractEmail(fromField) {
  if (!fromField) return '';
  // Formato "Nombre <correo@dominio.com>"
  const match = fromField.match(/<([^>]+)>/);
  if (match) return match[1].toLowerCase().trim();
  // Si no tiene <>, asumimos que el string completo es el correo
  return fromField.toLowerCase().trim();
}

function getOrCreateLabel(name) {
  let label = GmailApp.getUserLabelByName(name);
  if (!label) label = GmailApp.createLabel(name);
  return label;
}

/**
 * Verifica que el alias de envío (SEND_AS_ALIAS) esté configurado como
 * "Send mail as" en el Gmail de la cuenta que ejecuta el script.
 * Sin esto, msg.forward({from: alias}) fallaría silenciosamente o saldría
 * desde la cuenta default.
 */
function validarAliasConfigurado() {
  if (!CONFIG.SEND_AS_ALIAS) return true;  // sin alias, no hay nada que validar

  const aliases = GmailApp.getAliases();
  const cuentaActual = Session.getActiveUser().getEmail();

  // El alias es válido si (a) coincide con la cuenta actual, o (b) está
  // configurado como "Send mail as" en las settings de Gmail.
  if (CONFIG.SEND_AS_ALIAS === cuentaActual) return true;
  if (aliases.includes(CONFIG.SEND_AS_ALIAS)) return true;

  logBot('ERROR', 'Alias de envío NO configurado',
    `SEND_AS_ALIAS=${CONFIG.SEND_AS_ALIAS} no está disponible en la cuenta ${cuentaActual}. ` +
    `Aliases disponibles: [${aliases.join(', ') || 'ninguno'}]. ` +
    `Configúralo en Gmail → Settings → Accounts and Import → "Send mail as".`);
  return false;
}


// ============================================================================
// EXTRACCIÓN DE PROCESOS LABORALES → SHEET DE PROCESOS
// ============================================================================
//
// Cuando un correo se clasifica como laboral, además de reenviarlo se intenta
// leer el PDF del auto admisorio y cargar los datos del proceso (radicado,
// juzgado, demandante, ciudad, fecha de notificación, tipo de caso) en un
// Spreadsheet aparte que imita la estructura de "Procesos Laborales Repartidores".
//
// Pipeline:
//   obtenerPdfAdjunto → extraerTextoPdf (Drive OCR) → extraerCamposRegex →
//   [si faltan críticos] extraerCamposGemini → consolidarCampos → upsertProcesoEnSheet
//
// Todo el módulo es best-effort: cualquier fallo se loguea pero no afecta
// al reenvío, que ya ocurrió antes en procesarMensaje.

function extraerYUpsertProceso(msg, clasificacion) {
  const messageId = msg.getId();
  const sheetCfg = CONFIG.PROCESOS;

  // Sin spreadsheet destino configurado no podemos hacer nada útil.
  if (!sheetCfg.SPREADSHEET_ID) {
    logBot('WARN', 'Extracción saltada: PROCESOS.SPREADSHEET_ID vacío', messageId);
    return { ok: false, accion: 'skip', razon: 'sheet_no_configurado' };
  }

  const pdfBlob = obtenerPdfAdjunto(msg);
  if (!pdfBlob) {
    logBot('INFO', 'Extracción: correo sin PDF adjunto', messageId);
    return { ok: false, accion: 'skip', razon: 'sin_pdf' };
  }

  let texto = '';
  try {
    const r = extraerTextoPdf(pdfBlob);
    texto = r.texto || '';
  } catch (e) {
    logBot('WARN', 'OCR del PDF falló', `${messageId} → ${e.message}`);
    registrarPendiente(messageId, '', 'ocr_fallido');
    return { ok: false, accion: 'skip', razon: 'ocr_fallido' };
  }

  if (!texto || texto.length < 50) {
    logBot('WARN', 'OCR devolvió texto vacío o muy corto', `${messageId} chars=${texto.length}`);
    registrarPendiente(messageId, '', 'ocr_vacio');
    return { ok: false, accion: 'skip', razon: 'ocr_vacio' };
  }

  // Regex first
  const camposRegex = extraerCamposRegex(texto);

  // Gemini fallback solo si faltan críticos y está habilitado
  let camposGemini = null;
  const faltanCriticos = sheetCfg.CAMPOS_CRITICOS.some(c => !camposRegex[c]);
  if (faltanCriticos && sheetCfg.USAR_GEMINI_FALLBACK) {
    camposGemini = extraerCamposGemini(texto, camposRegex);
  }

  const consolidado = consolidarCampos(camposRegex, camposGemini, msg);

  if (!consolidado.radicado) {
    logBot('WARN', 'No se pudo extraer radicado', `${messageId} | from=${extractEmail(msg.getFrom())}`);
    registrarPendiente(messageId, '', 'sin_radicado');
    return { ok: false, accion: 'skip', razon: 'sin_radicado' };
  }

  const resultado = upsertProcesoEnSheet(consolidado);
  logBot('OK', `Proceso ${resultado.accion}`,
    `${messageId} | radicado=${consolidado.radicado} | fila=${resultado.fila} | celdas=${resultado.celdasActualizadas || 0}`);

  return { ok: true, accion: resultado.accion, radicado: consolidado.radicado };
}

function obtenerPdfAdjunto(msg) {
  const adjuntos = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  const pdfs = adjuntos.filter(a => {
    const nombre = (a.getName() || '').toLowerCase();
    const mime = a.getContentType();
    return mime === 'application/pdf' || nombre.endsWith('.pdf');
  });

  if (pdfs.length === 0) return null;

  if (pdfs.length > 1) {
    const nombres = pdfs.map(p => p.getName()).join(', ');
    logBot('WARN', `Múltiples PDFs adjuntos (${pdfs.length}) — tomando el más grande`, nombres);
  }

  // Tomar el PDF más grande (típicamente el auto admisorio vs anexos pequeños).
  pdfs.sort((a, b) => b.getBytes().length - a.getBytes().length);
  const elegido = pdfs[0];

  if (elegido.getBytes().length > CONFIG.PROCESOS.PDF_MAX_BYTES) {
    logBot('WARN', 'PDF excede límite de tamaño',
      `${elegido.getName()} bytes=${elegido.getBytes().length}`);
    return null;
  }
  return elegido;
}

/**
 * Convierte un blob de PDF a texto usando Drive API v2 con OCR.
 * Requiere que Drive API v2 esté habilitada como advanced service.
 * Crea un Google Doc temporal, extrae el texto, y lo borra en finally.
 */
function extraerTextoPdf(blob) {
  if (typeof Drive === 'undefined') {
    throw new Error('Drive API v2 advanced service no habilitado');
  }
  let fileId = null;
  try {
    const file = Drive.Files.insert(
      {
        title: 'tmp_ocr_' + Date.now(),
        mimeType: 'application/vnd.google-apps.document'
      },
      blob,
      { ocr: true, ocrLanguage: 'es' }
    );
    fileId = file.id;
    const doc = DocumentApp.openById(fileId);
    const texto = doc.getBody().getText() || '';
    return { texto: texto, metodo: 'drive_ocr', paginas: 0 };
  } finally {
    if (fileId) {
      try { Drive.Files.remove(fileId); } catch (e) {
        logBot('WARN', 'No se pudo borrar archivo temporal de OCR', `${fileId} → ${e.message}`);
      }
    }
  }
}

function extraerCamposRegex(texto) {
  const t = (texto || '').replace(/\s+/g, ' ');
  const tLower = t.toLowerCase();

  const out = {
    radicado: null,
    juzgado: null,
    demandante: null,
    ciudad: null,
    fechaNotificacion: null,  // Date|null
    tipoCaso: null,
    _faltantes: [],
  };

  // --- Radicado: 23 dígitos con o sin separadores ---
  // Formato estándar colombiano: 11001310502120240012300 (puede venir con guiones/espacios)
  const reRadicado23 = /\b(\d{5}\s*[-\s]?\s*\d{2}\s*[-\s]?\s*\d{2}\s*[-\s]?\s*\d{3}\s*[-\s]?\s*\d{4}\s*[-\s]?\s*\d{5}\s*[-\s]?\s*\d{2})\b/;
  let m = t.match(reRadicado23);
  if (m) out.radicado = normalizarRadicado(m[1]);
  if (!out.radicado) {
    // Buscar como secuencia "limpia" de exactamente 23 dígitos
    const m2 = t.replace(/[-\s]/g, '').match(/\b(\d{23})\b/);
    if (m2) out.radicado = m2[1];
  }

  // --- Juzgado ---
  const reJuzgado = /juzgado\s+([a-záéíóúñ0-9°º\s]+?(?:laboral(?:es)?\s+del\s+circuito|laboral|municipal\s+de\s+pequeñas\s+causas\s+laborales)[^.\n\r]{0,120})/i;
  m = t.match(reJuzgado);
  if (m) {
    out.juzgado = ('Juzgado ' + m[1]).replace(/\s+/g, ' ').trim();
    // Ciudad heurística desde el juzgado: "...de Bogotá D.C." / "...de Medellín"
    const ciudadFromJuz = out.juzgado.match(/\bde\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ\.\s]+?)(?:\s*[-,]|\s*$)/);
    if (ciudadFromJuz) out.ciudad = ciudadFromJuz[1].trim().replace(/\s+/g, ' ');
  }

  // --- Demandante ---
  // Trabajamos sobre el texto original (con mayúsculas) para preservar nombres propios.
  const reDemandante = /(?:parte\s+)?demandante[s]?\s*[:\-]?\s*([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ' ]{3,100}?)(?=\s*(?:demandado|c\.?c\.?\b|cédula|nit\b|\.|$|,\s*identificad))/;
  m = t.match(reDemandante);
  if (m) out.demandante = m[1].trim().replace(/\s+/g, ' ');

  // --- Fecha de notificación ---
  const meses = {
    'enero': 0, 'febrero': 1, 'marzo': 2, 'abril': 3, 'mayo': 4, 'junio': 5,
    'julio': 6, 'agosto': 7, 'septiembre': 8, 'setiembre': 8, 'octubre': 9,
    'noviembre': 10, 'diciembre': 11
  };
  const reFecha = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(20\d{2})/i;
  m = tLower.match(reFecha);
  if (m) {
    const dia = parseInt(m[1], 10);
    const mes = meses[m[2].toLowerCase()];
    const anio = parseInt(m[3], 10);
    if (mes !== undefined && dia >= 1 && dia <= 31) {
      out.fechaNotificacion = new Date(anio, mes, dia);
    }
  }

  // --- Tipo de caso ---
  if (/(?:contrato\s+realidad|primac[ií]a\s+de\s+la\s+realidad|declaraci[oó]n\s+de\s+(?:la\s+)?existencia\s+(?:del\s+)?contrato)/i.test(t)) {
    out.tipoCaso = 'Declaración Contrato Realidad';
  }

  // Diagnóstico de faltantes
  ['radicado', 'juzgado', 'demandante', 'ciudad', 'fechaNotificacion', 'tipoCaso'].forEach(k => {
    if (!out[k]) out._faltantes.push(k);
  });

  return out;
}

function extraerCamposGemini(texto, camposParciales) {
  const apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    logBot('WARN', 'Gemini fallback omitido: GEMINI_API_KEY no configurada', '');
    return null;
  }

  const cfg = CONFIG.PROCESOS;
  const textoTrunc = (texto || '').slice(0, cfg.TEXTO_OCR_MAX_CHARS);

  const systemPrompt =
    'Eres un asistente que extrae datos estructurados de autos admisorios de demanda laboral en Colombia. ' +
    'Recibes el texto OCR de un PDF judicial. Responde EXCLUSIVAMENTE con JSON válido, sin texto adicional, ' +
    'sin markdown. Si un campo no aparece claramente en el texto, su valor debe ser null. No inventes datos.';

  const userPrompt =
    'Texto del auto admisorio:\n"""\n' + textoTrunc + '\n"""\n\n' +
    'Campos ya detectados por regex (pueden ser null o estar incompletos):\n' +
    JSON.stringify({
      radicado: camposParciales.radicado,
      juzgado: camposParciales.juzgado,
      demandante: camposParciales.demandante,
      ciudad: camposParciales.ciudad,
      fechaNotificacion: camposParciales.fechaNotificacion
        ? Utilities.formatDate(camposParciales.fechaNotificacion, 'UTC', 'yyyy-MM-dd')
        : null,
      tipoCaso: camposParciales.tipoCaso,
    }) +
    '\n\nDevuelve un JSON con esta forma exacta:\n' +
    '{\n' +
    '  "radicado": string|null,\n' +
    '  "juzgado": string|null,\n' +
    '  "demandante": string|null,\n' +
    '  "ciudad": string|null,\n' +
    '  "fechaNotificacion": string|null,\n' +
    '  "tipoCaso": string|null\n' +
    '}';

  const body = {
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      maxOutputTokens: 512,
    },
  };

  const url = cfg.GEMINI_ENDPOINT + cfg.GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(apiKey);
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  };

  const maxAttempts = 1 + (cfg.GEMINI_MAX_RETRIES || 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = UrlFetchApp.fetch(url, options);
      const code = resp.getResponseCode();
      if (code >= 200 && code < 300) {
        const parsed = JSON.parse(resp.getContentText());
        const text = (((parsed.candidates || [])[0] || {}).content || {}).parts || [];
        const raw = text.map(p => p.text || '').join('').trim();
        if (!raw) {
          logBot('WARN', 'Gemini devolvió respuesta vacía', '');
          return null;
        }
        try {
          const data = JSON.parse(raw);
          return {
            radicado: data.radicado ? normalizarRadicado(data.radicado) : null,
            juzgado: data.juzgado || null,
            demandante: data.demandante || null,
            ciudad: data.ciudad || null,
            fechaNotificacion: data.fechaNotificacion ? parseFechaIso(data.fechaNotificacion) : null,
            tipoCaso: data.tipoCaso || null,
          };
        } catch (e) {
          logBot('WARN', 'Gemini devolvió JSON inválido', raw.slice(0, 200));
          return null;
        }
      }
      logBot('WARN', `Gemini HTTP ${code} (intento ${attempt}/${maxAttempts})`,
        resp.getContentText().slice(0, 300));
    } catch (e) {
      logBot('WARN', `Gemini fetch falló (intento ${attempt}/${maxAttempts})`, e.message);
    }
    if (attempt < maxAttempts) Utilities.sleep(2000);
  }
  return null;
}

function parseFechaIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

/**
 * Combina los campos extraídos por regex y Gemini, añade derivados,
 * y devuelve un array de 29 valores en el orden de CONFIG.PROCESOS.HEADERS.
 * Regex gana donde tiene valor; Gemini rellena nulls.
 */
function consolidarCampos(regex, gemini, msg) {
  const merge = (a, b) => (a != null && a !== '') ? a : (b != null && b !== '' ? b : null);

  const radicado = merge(regex.radicado, gemini && gemini.radicado);
  const juzgado = merge(regex.juzgado, gemini && gemini.juzgado);
  const demandante = merge(regex.demandante, gemini && gemini.demandante);
  const ciudad = merge(regex.ciudad, gemini && gemini.ciudad);
  const fechaNot = merge(regex.fechaNotificacion, gemini && gemini.fechaNotificacion) || msg.getDate();
  const tipoCaso = merge(regex.tipoCaso, gemini && gemini.tipoCaso) || 'Declaración Contrato Realidad';

  const mesRadicado = fechaNot
    ? Utilities.formatDate(fechaNot, Session.getScriptTimeZone(), 'yyyy-MM')
    : '';

  // Fila en orden A..AC (29 columnas). Las columnas que no podemos llenar
  // automáticamente quedan en '' para que el upsert respete celdas vacías.
  return {
    radicado: radicado,
    fila: [
      '',                                          // A
      '',                                          // B Link carpeta
      radicado || '',                              // C Número de Radicado
      'Laboral',                                   // D Tipo de acción
      juzgado || '',                               // E Juzgado
      '',                                          // F Tendencia
      ciudad || '',                                // G Ciudad
      demandante || '',                            // H Demandante
      '',                                          // I ID Soy Rappi
      '',                                          // J Es Rayo actualmente?
      '',                                          // K ¿Ha sido Rayo?
      '',                                          // L Responsable ED/CD
      'Notificación del auto admisorio de la demanda',  // M Estado Actual
      fechaNot || '',                              // N Fecha notificación auto admisorio
      '',                                          // O Fecha audiencia
      '',                                          // P Hora y articulos
      '',                                          // Q Fecha conciliación
      '',                                          // R Valor Conciliación
      '',                                          // S Valor Pretensión
      '',                                          // T Fecha otorgación poder
      '',                                          // U Honorarios Godoy
      '',                                          // V Pendiente Facturación Godoy
      tipoCaso || '',                              // W Tipo de caso
      '',                                          // X Ganancias totales
      'Notificación auto admisorio',               // Y Última actuación
      '',                                          // Z Resumen del caso
      mesRadicado,                                 // AA Mes radicado
      '',                                          // AB Mes conciliado
      '',                                          // AC Diff
    ],
  };
}

function upsertProcesoEnSheet(consolidado) {
  const sheet = getProcesosSheet();
  const radicadoNorm = normalizarRadicado(consolidado.radicado);
  const nuevasValues = consolidado.fila;

  // Buscar radicado existente en columna C (índice 3). Probamos varias formas
  // porque el sheet puede tener el radicado con guiones, espacios o limpio.
  const lastRow = sheet.getLastRow();
  let filaExistente = null;
  if (lastRow >= 2) {
    const rangoC = sheet.getRange(2, 3, lastRow - 1, 1).getValues();
    for (let i = 0; i < rangoC.length; i++) {
      const val = rangoC[i][0];
      if (val && normalizarRadicado(val.toString()) === radicadoNorm) {
        filaExistente = i + 2;
        break;
      }
    }
  }

  if (filaExistente === null) {
    sheet.appendRow(nuevasValues);
    return { accion: 'insert', fila: sheet.getLastRow(), celdasActualizadas: 29 };
  }

  // Update: solo escribir celdas vacías.
  const numCols = nuevasValues.length;
  const actuales = sheet.getRange(filaExistente, 1, 1, numCols).getValues()[0];
  let cambios = 0;
  const colsActualizadas = [];
  for (let col = 0; col < numCols; col++) {
    const vacioActual = actuales[col] === '' || actuales[col] === null;
    const nuevoTieneValor = nuevasValues[col] !== '' && nuevasValues[col] !== null;
    if (vacioActual && nuevoTieneValor) {
      actuales[col] = nuevasValues[col];
      cambios++;
      colsActualizadas.push(colNumToLetter(col + 1));
    }
  }
  if (cambios > 0) {
    sheet.getRange(filaExistente, 1, 1, numCols).setValues([actuales]);
    return { accion: 'update', fila: filaExistente, celdasActualizadas: cambios, columnas: colsActualizadas };
  }
  return { accion: 'skip', fila: filaExistente, celdasActualizadas: 0 };
}

function getProcesosSheet() {
  const cfg = CONFIG.PROCESOS;
  const nombre = CONFIG.DRY_RUN ? cfg.SHEET_NAME_DRY : cfg.SHEET_NAME;
  return getOrCreateSheet(nombre, cfg.HEADERS, cfg.SPREADSHEET_ID);
}

function normalizarRadicado(raw) {
  if (!raw) return '';
  return raw.toString().replace(/[\s\-_]/g, '').trim();
}

function colNumToLetter(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function registrarPendiente(messageId, radicadoParcial, razon) {
  try {
    const sheet = getOrCreateSheet(
      CONFIG.PROCESOS.PENDIENTES_SHEET_NAME,
      ['Timestamp', 'MessageID', 'Radicado_parcial', 'Razon', 'Reintentos', 'DryRun'],
      CONFIG.PROCESOS.SPREADSHEET_ID
    );
    sheet.appendRow([new Date(), messageId, radicadoParcial || '', razon, 0, CONFIG.DRY_RUN]);
  } catch (e) {
    logBot('WARN', 'No se pudo registrar pendiente de extracción', `${messageId} → ${e.message}`);
  }
}

/**
 * Verifica que el módulo de extracción tenga la configuración mínima:
 *  - SPREADSHEET_ID seteado
 *  - GEMINI_API_KEY en Script Properties (si USAR_GEMINI_FALLBACK=true)
 *  - Drive advanced service habilitado
 * NUNCA bloquea la corrida; solo loguea warnings.
 */
function validarExtraccionConfigurada() {
  const cfg = CONFIG.PROCESOS;
  if (!cfg.SPREADSHEET_ID) {
    logBot('WARN', 'PROCESOS.SPREADSHEET_ID vacío — extracción no podrá escribir',
      'Crear un Spreadsheet nuevo y pegar su ID en CONFIG.PROCESOS.SPREADSHEET_ID');
  }
  if (cfg.USAR_GEMINI_FALLBACK) {
    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!key) {
      logBot('WARN', 'GEMINI_API_KEY no configurada en Script Properties',
        'Solo regex correrá. Setear en Project Settings → Script Properties.');
    }
  }
  if (typeof Drive === 'undefined') {
    logBot('WARN', 'Drive API v2 advanced service no habilitado',
      'Habilitar en Services del editor de Apps Script para que funcione el OCR.');
  }
}

/**
 * Utilidad manual: corre la extracción aislada sobre un correo específico.
 * Útil para depurar regex/Gemini sin esperar al cron.
 *
 * Uso desde el editor de Apps Script:
 *   1. Ejecutar testExtraccionMensaje con un messageId real.
 *   2. Revisar la pestaña destino y BOT_LOG_LABORAL.
 */
function testExtraccionMensaje(messageId) {
  if (!messageId) {
    throw new Error('Pasa un messageId. Cómo obtenerlo: abre un correo en Gmail y mira la URL.');
  }
  const msg = GmailApp.getMessageById(messageId);
  if (!msg) throw new Error('Mensaje no encontrado: ' + messageId);
  const clasif = clasificarComoLaboral(msg);
  logBot('INFO', 'testExtraccion: clasificación', JSON.stringify(clasif));
  const r = extraerYUpsertProceso(msg, clasif);
  logBot('INFO', 'testExtraccion: resultado', JSON.stringify(r));
  return r;
}

/**
 * Utilidad manual: reintenta extracción para correos que cayeron en la pestaña
 * BOT_EXTRACCION_PENDIENTE por causa recuperable (OCR timeout, Gemini caído).
 */
function reprocesarExtraccionPendiente() {
  const cfg = CONFIG.PROCESOS;
  if (!cfg.SPREADSHEET_ID) {
    logBot('ERROR', 'reprocesarExtraccionPendiente: SPREADSHEET_ID vacío', '');
    return;
  }
  const sheet = getOrCreateSheet(
    cfg.PENDIENTES_SHEET_NAME,
    ['Timestamp', 'MessageID', 'Radicado_parcial', 'Razon', 'Reintentos', 'DryRun'],
    cfg.SPREADSHEET_ID
  );
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    logBot('INFO', 'reprocesarExtraccionPendiente: nada pendiente', '');
    return;
  }
  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  let exitos = 0, fallos = 0;
  for (let i = 0; i < data.length; i++) {
    const messageId = data[i][1];
    const fueDryRun = data[i][5] === true || data[i][5] === 'TRUE' || data[i][5] === 'true';
    if (!messageId || fueDryRun !== CONFIG.DRY_RUN) continue;
    try {
      const msg = GmailApp.getMessageById(messageId);
      if (!msg) { fallos++; continue; }
      const clasif = clasificarComoLaboral(msg);
      const r = extraerYUpsertProceso(msg, clasif);
      if (r.ok) {
        exitos++;
        sheet.getRange(i + 2, 5).setValue((data[i][4] || 0) + 1);
      } else {
        fallos++;
      }
    } catch (e) {
      fallos++;
      logBot('WARN', 'reprocesarExtraccionPendiente: fallo en mensaje', `${messageId} → ${e.message}`);
    }
  }
  logBot('INFO', 'reprocesarExtraccionPendiente terminado', `exitos=${exitos} fallos=${fallos}`);
}


// ============================================================================
// INSTALACIÓN / MANTENIMIENTO — ejecutar manualmente desde el editor
// ============================================================================

/**
 * Ejecutar UNA vez para instalar el cron cada 15 min.
 * Borra cualquier trigger previo de esta misma función antes de crear uno nuevo.
 */
function setupTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'procesarCorreosLaborales') {
      ScriptApp.deleteTrigger(t);
    }
  }
  ScriptApp.newTrigger('procesarCorreosLaborales')
    .timeBased()
    .everyMinutes(15)
    .create();
  logBot('INFO', 'Trigger instalado', 'procesarCorreosLaborales cada 15 minutos');
}

/**
 * Para probar manualmente: ejecuta una corrida sola en este momento.
 * Mira la pestaña BOT_LOG_LABORAL después de correr.
 */
function testManual() {
  procesarCorreosLaborales();
}

/**
 * Apaga el bot: borra todos los triggers.
 */
function apagarBot() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === 'procesarCorreosLaborales') {
      ScriptApp.deleteTrigger(t);
    }
  }
  logBot('INFO', 'Bot apagado', 'Todos los triggers fueron eliminados');
}
