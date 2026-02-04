/**
 * RECIBE EL WEBHOOK DE TYPEBOT (sin cambios, ya está bien)
 */
function doPost(e) {
  console.log("--- WEBHOOK RECIBIDO ---");
  try {
    const data = JSON.parse(e.postData.contents);
    const uniqueId = "task_" + new Date().getTime() + "_" + Math.floor(Math.random() * 10000);
    
    CacheService.getScriptCache().put(uniqueId, JSON.stringify(data), 21600);

    const props = PropertiesService.getScriptProperties();
    const lock = LockService.getScriptLock();
    
    lock.waitLock(5000);
    let pending = JSON.parse(props.getProperty('PENDING_TASKS') || "[]");
    pending.push(uniqueId);
    props.setProperty('PENDING_TASKS', JSON.stringify(pending));
    lock.releaseLock();

    // Solo crear trigger si no hay uno activo
    if (!hasPendingTrigger('processWebhookData')) {
      ScriptApp.newTrigger('processWebhookData')
        .timeBased()
        .after(1)
        .create();
    }

    console.log("✅ Tarea encolada:", uniqueId);

    return ContentService.createTextOutput(JSON.stringify({ status: 'success', id: uniqueId }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error("❌ Error en doPost:", err.toString());
    return ContentService.createTextOutput(JSON.stringify({ status: 'error' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * PROCESA LA COLA (DRIVE + ATTIO) - VERSIÓN MEJORADA PARA MÚLTIPLES DECKS
 */
function processWebhookData() {
  console.log("--- INICIANDO PROCESAMIENTO ---");
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  
  // Timeout más largo para procesar múltiples items
  if (!lock.tryLock(30000)) {
    console.log("⚠️ No se pudo obtener lock, reintentando más tarde");
    return;
  }

  const cache = CacheService.getScriptCache();
  let processedCount = 0;
  const MAX_ITEMS_PER_RUN = 5; // Procesar máximo 5 decks por ejecución

  try {
    while (processedCount < MAX_ITEMS_PER_RUN) {
      // Obtener siguiente tarea
      let pending = JSON.parse(props.getProperty('PENDING_TASKS') || "[]");
      
      if (pending.length === 0) {
        console.log("✅ No hay más tareas pendientes");
        break;
      }

      const currentTaskId = pending.shift();
      props.setProperty('PENDING_TASKS', JSON.stringify(pending));
      
      console.log(`📦 Procesando tarea ${processedCount + 1}: ${currentTaskId}`);

      // Procesar la tarea actual
      try {
        const rawData = cache.get(currentTaskId);
        if (!rawData) {
          console.error("⚠️ No hay datos en cache para:", currentTaskId);
          continue;
        }
        
        const data = JSON.parse(rawData);
        const ATTIO_TOKEN = props.getProperty('ATTIO_TOKEN');
        const FOLDER_ID = props.getProperty('DRIVE_FOLDER_ID');

        if (!ATTIO_TOKEN || !FOLDER_ID) {
          throw new Error("Faltan credenciales en Properties.");
        }

        // GUARDAR EN DRIVE
        console.log("⬇️ Descargando archivo...");
        const responseFile = UrlFetchApp.fetch(data.fileUrl, { "muteHttpExceptions": true });
        
        if (responseFile.getResponseCode() !== 200) {
          console.error("❌ Error descarga:", responseFile.getResponseCode());
          continue;
        }

        const blob = responseFile.getBlob().setName(data.fileName || "deck_" + currentTaskId);
        const folder = DriveApp.getFolderById(FOLDER_ID.trim());
        const file = folder.createFile(blob);
        
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        const fileDriveUrl = `https://drive.google.com/file/d/${file.getId()}/preview`;

        console.log("✅ Archivo guardado en Drive:", file.getId());

        // ACTUALIZAR ATTIO CON LA URL DEL DECK
        const urlRecord = `https://api.attio.com/v2/objects/deals/records/${data.recordId}`;

        const attioResRecord = UrlFetchApp.fetch(urlRecord, {
          method: "PATCH",
          headers: {
            "Authorization": "Bearer " + ATTIO_TOKEN.trim(),
            "Content-Type": "application/json"
          },
          payload: JSON.stringify({
            data: { values: { "deck_url": fileDriveUrl } }
          }),
          muteHttpExceptions: true
        });

        console.log("✅ URL actualizada en Attio");

        // AGREGAR A COLA DE RESÚMENES
        const summaryTaskId = "summary_" + currentTaskId;
        const summaryTaskData = {
          fileId: file.getId(),
          recordId: data.recordId,
          timestamp: new Date().getTime()
        };

        props.setProperty(summaryTaskId, JSON.stringify(summaryTaskData));
        console.log("📝 Tarea de resumen encolada:", summaryTaskId);

        processedCount++;

      } catch (itemError) {
        console.error("💥 Error procesando item:", currentTaskId, itemError.toString());
        // Continuar con el siguiente item
      }
    }

    // Programar trigger de resúmenes si hay tareas pendientes
    if (processedCount > 0) {
      if (!hasPendingTrigger('processSummaryTask')) {
        ScriptApp.newTrigger('processSummaryTask')
          .timeBased()
          .after(2000) // 2 segundos de delay
          .create();
        console.log("🤖 Trigger de resumen programado");
      }
    }

    // Si quedan tareas, programar otra ejecución
    const remainingPending = JSON.parse(props.getProperty('PENDING_TASKS') || "[]");
    if (remainingPending.length > 0) {
      console.log(`⏭️ Quedan ${remainingPending.length} tareas, programando siguiente ejecución`);
      
      if (!hasPendingTrigger('processWebhookData')) {
        ScriptApp.newTrigger('processWebhookData')
          .timeBased()
          .after(1000)
          .create();
      }
    }

  } catch (e) {
    console.error("💥 ERROR GENERAL:", e.toString());
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    deleteFinishedTriggers('processWebhookData');
    console.log(`--- FINALIZADO: ${processedCount} tareas procesadas ---`);
  }
}

/**
 * PROCESA RESÚMENES - VERSIÓN MEJORADA PARA MÚLTIPLES DECKS
 */
function processSummaryTask() {
  console.log("--- INICIANDO GENERACIÓN DE RESÚMENES ---");
  
  const props = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  
  if (!lock.tryLock(30000)) {
    console.log("⚠️ No se pudo obtener lock para resúmenes");
    return;
  }

  let processedCount = 0;
  const MAX_SUMMARIES_PER_RUN = 3; // Máximo 3 resúmenes por ejecución (Gemini puede ser lento)

  try {
    const allProps = props.getProperties();
    const summaryTasks = [];
    
    // Recolectar todas las tareas de resumen
    for (let key in allProps) {
      if (key.startsWith('summary_')) {
        const taskData = JSON.parse(allProps[key]);
        summaryTasks.push({
          id: key,
          data: taskData
        });
      }
    }

    console.log(`📋 Encontradas ${summaryTasks.length} tareas de resumen pendientes`);

    if (summaryTasks.length === 0) {
      lock.releaseLock();
      return;
    }

    // Ordenar por timestamp (las más antiguas primero)
    summaryTasks.sort((a, b) => (a.data.timestamp || 0) - (b.data.timestamp || 0));

    // Procesar hasta MAX_SUMMARIES_PER_RUN tareas
    for (let i = 0; i < Math.min(summaryTasks.length, MAX_SUMMARIES_PER_RUN); i++) {
      const task = summaryTasks[i];
      
      try {
        console.log(`\n🤖 [${i + 1}/${summaryTasks.length}] Procesando resumen: ${task.id}`);
        
        // Eliminar de Properties ANTES de procesar (evitar reprocesamiento)
        props.deleteProperty(task.id);
        
        const ATTIO_TOKEN = props.getProperty('ATTIO_TOKEN');
        const geminiKey = props.getProperty("GEMINI_API_KEY");

        if (!ATTIO_TOKEN || !geminiKey) {
          console.error("❌ Faltan credenciales");
          continue;
        }

        const file = DriveApp.getFileById(task.data.fileId);
        const pdfBlob = file.getBlob();

        console.log("📄 Archivo recuperado:", task.data.fileId);

        // GENERAR RESUMEN CON GEMINI
        console.log("🤖 Llamando a Gemini...");
        const summary = generateGeminiSummary(pdfBlob, geminiKey);

        console.log("✅ Resumen generado (primeros 200 chars):", summary.substring(0, 200));

        // CREAR NOTA CON EL RESUMEN
        const urlNotes = "https://api.attio.com/v2/notes";

        const attioResNote = UrlFetchApp.fetch(urlNotes, {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + ATTIO_TOKEN.trim(),
            "Content-Type": "application/json"
          },
          payload: JSON.stringify({
            data: {
              "parent_object": "deals",
              "parent_record_id": task.data.recordId,
              "title": "Resumen del deck (Gemini)",
              "format": "plaintext",
              "content": summary
            }
          }),
          muteHttpExceptions: true
        });

        if (attioResNote.getResponseCode() === 200) {
          console.log("✅ NOTA CREADA CORRECTAMENTE");
          processedCount++;
        } else {
          console.error("❌ Error creando nota:", attioResNote.getContentText());
        }

      } catch (taskError) {
        console.error(`💥 Error en tarea ${task.id}:`, taskError.toString());
        // Continuar con la siguiente tarea
      }
    }

    // Si quedan tareas de resumen, programar otra ejecución
    const remainingSummaries = summaryTasks.length - processedCount;
    if (remainingSummaries > 0) {
      console.log(`\n⏭️ Quedan ${remainingSummaries} resúmenes pendientes, programando siguiente ejecución`);
      
      if (!hasPendingTrigger('processSummaryTask')) {
        ScriptApp.newTrigger('processSummaryTask')
          .timeBased()
          .after(5000) // 5 segundos entre lotes de resúmenes
          .create();
      }
    }

  } catch (e) {
    console.error("💥 ERROR GENERAL EN RESÚMENES:", e.toString());
    console.error("Stack:", e.stack);
  } finally {
    if (lock.hasLock()) lock.releaseLock();
    deleteFinishedTriggers('processSummaryTask');
    console.log(`--- FINALIZADO: ${processedCount} resúmenes generados ---`);
  }
}

/**
 * FUNCION PARA USAR GEMINI - CON DEBUGGING MEJORADO
 */
function generateGeminiSummary(pdfBlob, apiKey) {
  const MODEL_NAME = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${apiKey}`;

  try {
    const pdfBytes = pdfBlob.getBytes();
    const sizeInMB = pdfBytes.length / (1024 * 1024);
    console.log("📊 Tamaño del PDF:", sizeInMB.toFixed(2), "MB");

    // Intentar método directo primero
    if (sizeInMB < 15) {
      console.log("✅ PDF pequeño - enviando directamente a Gemini");
      
      const base64Data = Utilities.base64Encode(pdfBytes);
      
      const payload = {
          "contents": [{
            "parts": [
              {
                // CAMBIO EN EL PROMPT: Pedimos una estructura que obligue a extenderse
                "text": "Analiza este PDF y crea un resumen ejecutivo conciso de 500 palabras. Es fundamental que cumplas con esta extensión." +
                "Estructura la respuesta así:" +
                "1) Idea principal," +
                "2) Propuesta de valor," +
                "3) Mercado y" +
                "4) Modelo de negocio." +
                "Sé directo y evita introducciones innecesarias."
              },
              {
                "inline_data": {
                  "mime_type": "application/pdf",
                  "data": base64Data
                }
              }
            ]
          }],
          "generationConfig": {
            "temperature": 0.4, // Subimos un poco para que sea menos "seco"
            "maxOutputTokens": 2048, // Aumentamos al máximo del modelo Flash estándar
            "topP": 0.95,
            "topK": 40
          },
        "safetySettings": [
          {
            "category": "HARM_CATEGORY_HARASSMENT",
            "threshold": "BLOCK_NONE"
          },
          {
            "category": "HARM_CATEGORY_HATE_SPEECH",
            "threshold": "BLOCK_NONE"
          },
          {
            "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "threshold": "BLOCK_NONE"
          },
          {
            "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
            "threshold": "BLOCK_NONE"
          }
        ]
      };

      const options = {
        "method": "POST",
        "contentType": "application/json",
        "payload": JSON.stringify(payload),
        "muteHttpExceptions": true
      };

      console.log("🚀 Enviando solicitud a Gemini (método directo)...");
      const response = UrlFetchApp.fetch(url, options);
      const resText = response.getContentText();
      const responseCode = response.getResponseCode();
      
      console.log("📥 Código de respuesta:", responseCode);

      if (responseCode !== 200) {
        console.error("❌ Error de la API de Gemini:", resText);
        console.log("⚠️ Intentando con método de extracción de texto...");
        return extractTextAndSummarize(pdfBlob, apiKey, url);
      }

      const json = JSON.parse(resText);

      // DEBUGGING DETALLADO
      console.log("🔍 Estructura de respuesta:", JSON.stringify(json, null, 2));

      // Verificar bloqueos de seguridad
      if (json.candidates && json.candidates[0]) {
        const candidate = json.candidates[0];
        
        console.log("🔍 Finish reason:", candidate.finishReason);
        console.log("🔍 Safety ratings:", JSON.stringify(candidate.safetyRatings));
        
        // Si fue bloqueado por seguridad
        if (candidate.finishReason === "SAFETY") {
          console.error("⚠️ BLOQUEADO POR FILTROS DE SEGURIDAD");
          console.log("🔄 Intentando con método de extracción de texto...");
          return extractTextAndSummarize(pdfBlob, apiKey, url);
        }

        // Si el resumen fue truncado
        if (candidate.finishReason === "MAX_TOKENS") {
          console.error("⚠️ RESPUESTA TRUNCADA POR LÍMITE DE TOKENS");
        }

        if (candidate.content && candidate.content.parts && candidate.content.parts[0]) {
          const summary = candidate.content.parts[0].text;
          const wordCount = summary.split(/\s+/).length;
          
          console.log("📝 Palabras en el resumen:", wordCount);
          console.log("📝 Caracteres en el resumen:", summary.length);
          
          if (wordCount < 20) {
            console.error("⚠️ RESUMEN DEMASIADO CORTO, intentando con texto extraído");
            return extractTextAndSummarize(pdfBlob, apiKey, url);
          }
          
          console.log("✅ Resumen generado exitosamente");
          return summary;
        } else {
          console.error("⚠️ No hay contenido en la respuesta");
          return extractTextAndSummarize(pdfBlob, apiKey, url);
        }
      } else {
        console.error("⚠️ No hay candidatos en la respuesta");
        return extractTextAndSummarize(pdfBlob, apiKey, url);
      }

    } else {
      console.log("📄 PDF grande - usando extracción de texto");
      return extractTextAndSummarize(pdfBlob, apiKey, url);
    }

  } catch (err) {
    console.error("💥 Error crítico en generateGeminiSummary:", err.toString());
    console.error("Stack completo:", err.stack);
    
    try {
      console.log("🔄 Último intento con OCR...");
      return extractTextAndSummarize(pdfBlob, apiKey, url);
    } catch (err2) {
      console.error("💥 Falló también el método OCR:", err2.toString());
      return "Error al procesar el resumen del deck. Por favor revisa los logs para más detalles.";
    }
  }
}

/**
 * FUNCION AUXILIAR: Extrae texto del PDF y genera resumen - MEJORADA
 */
function extractTextAndSummarize(pdfBlob, apiKey, geminiUrl) {
  const props = PropertiesService.getScriptProperties();
  const FOLDER_ID = props.getProperty('DRIVE_FOLDER_ID');
  
  let tempFileId = null;
  
  try {
    console.log("📝 Creando archivo temporal para OCR...");
    
    const folder = DriveApp.getFolderById(FOLDER_ID);
    const tempFile = folder.createFile(pdfBlob);
    tempFileId = tempFile.getId();
    
    console.log("🔍 Extrayendo texto del PDF...");
    
    let textoExtraido = "";
    
    try {
      // Intentar OCR con Drive API
      const resource = {
        title: "Temp_OCR_" + new Date().getTime(),
        mimeType: MimeType.GOOGLE_DOCS
      };
      
      const docFile = Drive.Files.copy(resource, tempFileId, {ocr: true});
      const doc = DocumentApp.openById(docFile.id);
      textoExtraido = doc.getBody().getText();
      
      Drive.Files.remove(docFile.id);
      
    } catch (ocrErr) {
      console.log("⚠️ OCR de Drive falló:", ocrErr.toString());
      textoExtraido = tempFile.getAs(MimeType.PLAIN_TEXT).getDataAsString();
    }
    
    // Limpiar el texto
    const textoLimpio = textoExtraido
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/"/g, "'")
      .trim()
      .substring(0, 40000); // Aumentado el límite

    console.log("📏 Texto extraído:", textoLimpio.length, "caracteres");
    console.log("📄 Primeros 500 caracteres:", textoLimpio.substring(0, 500));

    if (textoLimpio.length < 50) {
      return "El PDF parece estar vacío o no se pudo extraer texto legible. Contenido extraído: " + textoLimpio;
    }

    // Payload mejorado
    const payload = {
      "contents": [{
        "parts": [{
          "text": `Genera un resumen ejecutivo detallado de este documento. El resumen debe tener al menos 200 palabras y cubrir:

1. Idea principal del negocio o proyecto
2. Propuesta de valor única
3. Mercado objetivo y oportunidad
4. Modelo de negocio o estrategia
5. Equipo y capacidades clave

Sé específico y detallado. No uses formato Markdown.

DOCUMENTO A RESUMIR:

${textoLimpio}`
        }]
      }],
      "generationConfig": {
        "temperature": 0.4,
        "maxOutputTokens": 2048,
        "topP": 0.95,
        "topK": 40
      },
      "safetySettings": [
        {
          "category": "HARM_CATEGORY_HARASSMENT",
          "threshold": "BLOCK_NONE"
        },
        {
          "category": "HARM_CATEGORY_HATE_SPEECH",
          "threshold": "BLOCK_NONE"
        },
        {
          "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
          "threshold": "BLOCK_NONE"
        },
        {
          "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
          "threshold": "BLOCK_NONE"
        }
      ]
    };

    const options = {
      "method": "POST",
      "contentType": "application/json",
      "payload": JSON.stringify(payload),
      "muteHttpExceptions": true
    };

    console.log("🚀 Enviando texto extraído a Gemini...");
    const response = UrlFetchApp.fetch(geminiUrl, options);
    const resText = response.getContentText();
    const responseCode = response.getResponseCode();

    console.log("📥 Código de respuesta:", responseCode);
    console.log("📥 Respuesta completa:", resText);

    if (responseCode !== 200) {
      console.error("❌ Error de Gemini con texto:", resText);
      return "Error al generar resumen (Código: " + responseCode + "). Texto extraído tenía " + textoLimpio.length + " caracteres.";
    }

    const json = JSON.parse(resText);

    // Debugging detallado
    console.log("🔍 Finish reason:", json.candidates[0].finishReason);
    
    if (json.candidates && json.candidates[0] && json.candidates[0].content) {
      const summary = json.candidates[0].content.parts[0].text;
      const wordCount = summary.split(/\s+/).length;
      
      console.log("📝 Palabras generadas:", wordCount);
      console.log("✅ Resumen generado con texto extraído");
      
      if (wordCount < 20) {
        return `RESUMEN CORTO DETECTADO (${wordCount} palabras). Posible problema con el contenido del PDF. Primeros 1000 caracteres del texto extraído: ${textoLimpio.substring(0, 1000)}`;
      }
      
      return summary;
    } else {
      return "Gemini no pudo generar un resumen. Respuesta: " + resText;
    }

  } catch (err) {
    console.error("💥 Error en extractTextAndSummarize:", err.toString());
    throw err;
    
  } finally {
    if (tempFileId) {
      try {
        DriveApp.getFileById(tempFileId).setTrashed(true);
        console.log("🗑️ Archivo temporal eliminado");
      } catch (e) {
        console.error("⚠️ No se pudo eliminar archivo temporal:", e.toString());
      }
    }
  }
}

/**
 * HELPER: Verifica si ya existe un trigger pendiente
 */
function hasPendingTrigger(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      return true;
    }
  }
  return false;
}

/**
 * LIMPIEZA DE TRIGGERS (VERSIÓN MEJORADA)
 */
function deleteFinishedTriggers(functionName) {
  const triggers = ScriptApp.getProjectTriggers();
  let deletedCount = 0;
  
  for (let i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(triggers[i]);
      deletedCount++;
    }
  }
  
  if (deletedCount > 0) {
    console.log(`🗑️ Eliminados ${deletedCount} triggers de ${functionName}`);
  }
}

/**
 * LIMPIEZA DE TRIGGERS DE RESUMEN (ya no necesaria, usar deleteFinishedTriggers)
 */
function deleteSummaryTriggers() {
  deleteFinishedTriggers('processSummaryTask');
}
