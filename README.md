```mermaid
graph TD
    %% RECEPCIÓN
    A[Webhook Typebot] -->|doPost| B(Encolar Tarea)
    B -->|Guarda en| C[(Cache & Properties)]
    B --> D{¿Trigger activo?}
    D -- No --> E[Crear Trigger: processWebhookData]

    %% PROCESAMIENTO DE ARCHIVOS
    subgraph Registro [Procesar Archivos - 5 por vez]
    E --> F(processWebhookData)
    F --> G[Descargar Archivo del Deck]
    G --> H[Subir a Google Drive]
    H --> I[Actualizar Record en Attio: deck_url]
    I --> J[Encolar Tarea de Resumen]
    end

    %% GENERACIÓN DE RESÚMENES
    subgraph IA [IA & Resúmenes - 3 por vez]
    J --> K{¿Trigger activo?}
    K -- No --> L[Crear Trigger: processSummaryTask]
    L --> M(processSummaryTask)
    M --> N{¿Tamaño PDF?}
    
    %% Lógica Gemini
    N -- < 15MB --> O[Gemini: Envío Directo]
    N -- > 15MB --> P[OCR: Extraer Texto]
    P --> Q[Gemini: Resumen de Texto]
    
    O --> R[Crear NOTA en Attio con Resumen]
    Q --> R
    end

    %% CICLO DE REINTENTOS
    R --> S{¿Quedan tareas?}
    S -- Sí --> M
    F --> T{¿Quedan tareas?}
    T -- Sí --> F

    %% Estilos
    style B fill:#f9f,stroke:#333
    style J fill:#fff3e0,stroke:#e65100
    style R fill:#4A154B,color:#fff
    style M fill:#e1f5fe,stroke:#01579b
