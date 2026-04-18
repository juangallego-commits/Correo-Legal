/**
 * ============================================================================
 * LEGAL OPS MASTER — Módulo Laboral — V1.1 (MVP Fase 1)
 * ============================================================================
 *
 * Reenvía automáticamente correos de procesos laborales desde la bandeja
 * notificacionesrappi@rappi.com hacia Godoy (firma externa) + equipo legal
 * interno.
 *
 * APLICA TODAS LAS LECCIONES DE V16.0 SAFE MODE:
 *  - Filtro de tiempo: solo correos de las últimas 48h (newer_than:2d)
 *  - Anti-bucle: tracking de Message-ID en hoja de control
 *  - Marcado seguro: try/catch en etiquetas, marca leído/archiva SIEMPRE
 *  - Cuerpo original preservado: htmlBody = nota + msg.getBody()
 *  - Doble validación por Message-ID antes de procesar
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

function getOrCreateSheet(name, headers) {
  const ss = SpreadsheetApp.openById(CONFIG.MATRIX_ID);
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
