# 🌩️ Smability Data Collector (AWS Lambda)

Microservicio core del ecosistema **Smability**. Esta función AWS Lambda es responsable de la ingesta, validación y cálculo de datos provenientes de la red de sensores IoT (SMAA, CHAAK, SMAA Micro) y APIs meteorológicas, consolidando la información en la base de datos central (RDS) para la posterior generación de los modelos espaciales.

## ⚙️ Arquitectura y Flujo

1. **Ingesta de Datos:** Consume endpoints de la API BioBox y sensores propietarios en tiempo real.
2. **Transformación:** Mapea variables crudas (Temp, RH, PM2.5, PM10, O3, CO) a la estructura relacional.
3. **Motor Matemático (`weight-calculator.js`):** Aplica la norma oficial para calcular promedios móviles (1hr, 8hr, 12hr) y determina el Índice de Aire y Salud (IAS) con su respectiva categoría de riesgo.
4. **Almacenamiento:** Inserta y actualiza registros en MySQL (RDS) en las tablas `readings`, `weighted_readings` y `air_quality_index`.

## 📂 Estructura del Repositorio

- `smability-lambda.js`: Handler principal de la Lambda. Orquesta la descarga de configuración en S3, los fetch a la API y la inserción a BD.
- `weight-calculator.js`: Módulo de cálculo estadístico y de umbrales IAS.
- `deploy.sh`: Script bash para empaquetado y despliegue automatizado hacia AWS CloudShell.
- `package.json`: Definición de dependencias Node.js (`mysql2`, `axios`, `@aws-sdk/client-s3`).

## 🚀 Instalación Local (Desarrollo)

1. Clona este repositorio.
2. Instala las dependencias (Esto generará tu `package-lock.json` automáticamente):
   ```bash
   npm install

## 🚀 Instalación CloudShell
```bash
cd smability-data-collector
git pull origin main
./deploy.sh
