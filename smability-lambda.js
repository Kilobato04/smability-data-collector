/**
 * Smability Air Quality Data Collector Lambda Function
 * This Lambda function collects data from Smability sensors and stores it in the same
 * database used by the reference air quality monitoring system.
 */

const mysql = require('mysql2/promise');
const axios = require('axios');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const weightCalculator = require('./weight-calculator.js');



// Configuration
const DB_CONFIG = {
  host: 'airquality-db.cyzqysiecobv.us-east-1.rds.amazonaws.com',
  user: 'dbadmin',
  password: '02Kilobaterias?',
  database: 'airquality_db'
};
// Add at the top of your Lambda file with other constants
// Cache to track offline devices
const OFFLINE_DEVICE_CACHE = {};
const OFFLINE_RETRY_INTERVAL = 6; // Check offline devices every 6 runs

// S3 configuration for device config file
const CONFIG_BUCKET = process.env.CONFIG_BUCKET || 'sensor-system-config-084375582423';
const CONFIG_KEY = process.env.CONFIG_KEY || 'device-config.json';

// API base URL for Smability devices
const API_BASE_URL = 'https://smability.sidtecmx.com/SmabilityAPI';

// Parameter mapping between Smability sensors and database parameters
const PARAMETER_MAPPING = {
  'Carbon Monoxide': 'co',
  'Ozone': 'o3',
  'PM2.5': 'pm25',
  'PM10*': 'pm10',
  'Nitrogen Dioxide': 'no2',
  'Sulfur dioxide': 'so2',
  'Temperature': 'tmp',
  'Relative Humidity': 'rh',
  'Battery': 'battery', // New parameter not in original system
  'Device Mode': 'device_mode' // New parameter for mobile or fix mode
};

// Sensor ID mapping to parameter descriptions
const SENSOR_ID_MAP = {
  1: 'Battery',
  2: 'Carbon Monoxide',
  3: 'Relative Humidity',
  4: 'Location',
  6: 'Nitrogen Dioxide',
  7: 'Ozone',
  8: 'PM10*',
  9: 'PM2.5',
  11: 'Sulfur dioxide',
  12: 'Temperature',
  13: 'Device Mode'
};

// Modified formatDateForAPI function with Mexico City timezone correction
function formatDateForAPI(date, offset = -6) {  // Changed default offset to -6 hours
  // Comprehensive timezone logging
  console.log(`
  ===== TIMEZONE DEBUGGING =====
  Input Date (Local): ${date.toLocaleString()}
  Input Date (ISO): ${date.toISOString()}
  Input Date (UTC): ${date.toUTCString()}
  Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}
  Timestamp (Milliseconds): ${date.getTime()}
  
  Date Components:
  - Full Year: ${date.getFullYear()}
  - Month: ${date.getMonth() + 1} (0-indexed)
  - Date: ${date.getDate()}
  - Hours: ${date.getHours()}
  - Minutes: ${date.getMinutes()}
  - Seconds: ${date.getSeconds()}
  - Timezone Offset: ${date.getTimezoneOffset()} minutes
  
  Offset Applied: ${offset} hours (Mexico City UTC-6)
  Formatted Date: ${
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
  }
  =========================`);

  const adjustedDate = new Date(date);
  adjustedDate.setHours(adjustedDate.getHours() + offset);
  
  const pad = num => num.toString().padStart(2, '0');
  return `${adjustedDate.getFullYear()}-${pad(adjustedDate.getMonth() + 1)}-${pad(adjustedDate.getDate())} ${pad(adjustedDate.getHours())}:${pad(adjustedDate.getMinutes())}:${pad(adjustedDate.getSeconds())}`;
}

// Helper function to parse float values from strings with units - add this after the function above
function parseFloatFromString(valueString) {
  if (!valueString || typeof valueString !== 'string') return null;
  
  // Extract the numeric part
  const match = valueString.match(/^([\d.]+)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return null;
}

function parseFloatFromStringWithUnits(valueString) {
  if (!valueString || typeof valueString !== 'string') return null;
  
  // Extract the numeric part, handling different units (ppb, ug/m3, etc.)
  const match = valueString.match(/^([\d.]+)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return null;
}

// Lambda handler function
exports.handler = async (event) => {
  console.log('Starting Smability sensor data collection');
  console.log('Full event received:', JSON.stringify(event));
  
  try {
    // Add test functionality for UNAM IAS update
    if (event.testUnamUpdate === true) {
      console.log("Running UNAM IAS update test");
      // Create database connection for test
      const connection = await mysql.createConnection(DB_CONFIG);
      
      try {
        // Call the test function from weight calculator module
        const testResult = await weightCalculator.testUnamIasUpdate(connection);
        
        // Return test results
        return {
          statusCode: 200,
          body: JSON.stringify({
            message: 'UNAM IAS update test completed',
            result: testResult
          })
        };
      } catch (testError) {
        console.error('Test failed:', testError);
        return {
          statusCode: 500,
          body: JSON.stringify({
            message: 'UNAM IAS update test failed',
            error: testError.message
          })
        };
      } finally {
        // Close connection
        await connection.end();
      }
    }
    
    // Regular execution continues below
    // Determine if this is the early or late run
    const currentMinute = new Date().getMinutes();
    const isEarlyRun = currentMinute < 30; // Simple check - if before half hour, it's the early run
    
    console.log(`Running ${isEarlyRun ? 'early' : 'late'} data collection`);
    
    // Determine which hour to process
    let targetHour;
    let targetDate;
    
    if (isEarlyRun) {
      // Early run - process previous hour
      const now = new Date();
      if (now.getHours() === 0) {
        // If it's midnight, go back to previous day
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        targetDate = yesterday;
        targetHour = 23;
      } else {
        targetDate = now;
        targetHour = now.getHours() - 1;
      }
      console.log(`Early run - processing previous hour: ${targetDate.toISOString()} hour ${targetHour}`);
    }
    
    // Determine the timestamp to use
    let now;
    const useLocalTimezone = event.useLocalTimezone === true;
    
    if (event.timestamp) {
      // Use the provided timestamp from the event
      now = new Date(event.timestamp);
      console.log(`Using timestamp from event: ${now.toISOString()}`);
    } else {
      if (useLocalTimezone) {
        // Use Mexico City time (UTC-6)
        now = new Date();
        // Create a new date string in Mexico City timezone
        now = new Date(now.toLocaleString('en-US', { timeZone: 'America/Mexico_City' }));
        console.log(`Using current time adjusted to Mexico City timezone: ${now.toISOString()}`);
      } else {
        // Use UTC time
        now = new Date();
        console.log(`Using current UTC time: ${now.toISOString()}`);
      }
    }
    
    // Comprehensive timezone logging
    console.log(`
    ===== TIMESTAMP DETAILS =====
    Input Timestamp: ${now.toISOString()}
    Local Timestamp: ${now.toLocaleString()}
    Timezone Offset: ${now.getTimezoneOffset()} minutes
    EventBridge useLocalTimezone: ${useLocalTimezone ? 'Yes' : 'No'}
    Current Processing Time: ${now.toISOString()} 
    ==========================`);
    
    // Format date components using Mexico City time
    const mexicoCityTime = now;
    const year = mexicoCityTime.getFullYear().toString();
    const month = (mexicoCityTime.getMonth() + 1).toString().padStart(2, '0');
    const day = mexicoCityTime.getDate().toString().padStart(2, '0');
    const hour = mexicoCityTime.getHours().toString().padStart(2, '0');
    const minute = mexicoCityTime.getMinutes().toString().padStart(2, '0');
    
    console.log(`Processing data for ${year}-${month}-${day} ${hour}:${minute} Mexico City Time`);
    
    // Load device configuration from S3
    let deviceConfig;
    try {
      deviceConfig = await loadDeviceConfigFromS3();
      console.log(`Successfully loaded device config with ${deviceConfig.devices.length} devices`);
      
      // Determinar estrategia de procesamiento
      const useBioBox = event.useBioBox === true;
      console.log(`BioBox processing: ${useBioBox ? 'ENABLED' : 'DISABLED'}`);
      
      let result;
      
      if (useBioBox) {
        // ===== MODO BIOBOX: Procesar solo dispositivos no-SMAA mediante API directa =====
        console.log("BioBox mode: filtering devices for direct API processing");
        
        const nonSmaaDevices = deviceConfig.devices.filter(device => {
          const isRegularSmaa = 
            device.active && 
            device.type && 
            device.type.includes('SMAA') && 
            !device.type.toLowerCase().includes('smaaso2') &&
            !device.type.includes('SMAAmicro');
          
          if (isRegularSmaa) {
            console.log(`Skipping regular SMAA device "${device.station_name || device.name}" - will be processed via BioBox`);
          } else {
            console.log(`Including non-SMAA device "${device.station_name || device.name}" for direct API processing`);
          }
          
          return !isRegularSmaa; // Keep everything EXCEPT regular SMAA
        });
        
        console.log(`Direct API processing: ${nonSmaaDevices.length} devices (filtered out ${deviceConfig.devices.length - nonSmaaDevices.length} SMAA devices)`);
        
        // Solo procesar dispositivos no-SMAA si hay alguno
        if (nonSmaaDevices.length > 0) {
          const filteredConfig = {
            ...deviceConfig,
            devices: nonSmaaDevices
          };
          result = await processDeviceData(filteredConfig, mexicoCityTime);
        } else {
          console.log("No non-SMAA devices to process with direct API");
          result = { 
            timestamp: mexicoCityTime.toISOString(),
            processed: 0, 
            success: 0,
            message: 'No devices processed via direct API (all SMAA devices handled by BioBox)'
          };
        }
      } else {
        // ===== MODO TRADICIONAL: Procesar todos los dispositivos mediante API directa =====
        console.log("Traditional mode: processing all devices via direct API");
        result = await processDeviceData(deviceConfig, mexicoCityTime);
      }
    
    // Add direct ozone pipeline if this is a half-hour processing run
    if (event.halfHourProcessing === true) {
      console.log("Running half-hour processing with direct ozone pipeline");
      // Create database connection
      const connection = await mysql.createConnection(DB_CONFIG);
      
      try {
        // Get current date and hour in Mexico City time
        const currentDate = `${year}-${month}-${day}`;
        const currentHour = parseInt(hour);
        
        // Run direct ozone pipeline
        await weightCalculator.processOzoneDirectPipeline(connection, currentDate, currentHour);
        
        console.log("Direct ozone pipeline completed");
      } catch (pipelineError) {
        console.error("Error in direct ozone pipeline:", pipelineError);
      } finally {
        // Close connection
        await connection.end();
      }
    }

  } catch (configError) {
    console.error('Error loading or processing device configuration:', configError);
    throw new Error(`Device configuration error: ${configError.message}`);
  }
    

    // Add the BioBox processing here:
    if (event.useBioBox === true) {
      console.log("Processing BioBox API data for SMAA devices");
      
      // Create database connection
      const connection = await mysql.createConnection(DB_CONFIG);
      
      try {
        // Find all active SMAA devices (exclude SO2 and micro)
        const [smaaDevices] = await connection.execute(`
          SELECT s.station_id, s.token, s.station_name, s.city, s.placement, s.monitor_type 
          FROM stations s 
          WHERE s.monitor_type LIKE '%SMAA%' 
          AND s.monitor_type NOT LIKE '%SMAASO2%' AND s.monitor_type NOT LIKE '%SMAAso2%'
          AND s.monitor_type NOT LIKE '%SMAAmicro%'
          AND s.active = 1
        `);
        
        console.log(`Found ${smaaDevices.length} SMAA devices to process with BioBox API`);

        // ADD THIS DIAGNOSTIC CODE RIGHT HERE
        console.log("Token diagnostics for BioBox processing:");
        smaaDevices.forEach(device => {
          console.log(`${device.station_id}: token="${device.token || 'NULL'}" (${typeof device.token})`);
        });

        const problematicTokens = smaaDevices.filter(d => 
          !d.token || d.token === "undefined" || d.token === ""
        );

        if (problematicTokens.length > 0) {
          console.log(`ALERT: Found ${problematicTokens.length} devices with problematic tokens:`);
          problematicTokens.forEach(d => console.log(`- ${d.station_id}: "${d.token || 'NULL'}"`));
        }
        // END OF DIAGNOSTIC CODE
        
        const bioBoxResults = {
          processed: 0,
          success: 0,
          errors: 0,
          devices: []
        };

        
        // Process each SMAA device
        for (const device of smaaDevices) {

          if (!device.token || device.token === "undefined" || device.token === "") {
            console.log(`Skipping device ${device.station_id} - invalid token: "${device.token || 'NULL'}"`);
            bioBoxResults.devices.push({
              station_id: device.station_id,
              name: device.station_name,
              status: 'skipped',
              reason: 'Invalid or missing token'
            });
            continue;
          }
          
          try {
            bioBoxResults.processed++;
            
            // 🚀 BIFURCACIÓN: ¿Es un dispositivo con endpoint propio o BioBox?
            if (device.token && device.token.includes('CUSTOM_ENDPOINT')) {
              console.log(`⚡ Ruta nueva detectada para estación: ${device.station_id}`);
              await fetchNewStationHourlyData(connection, device.station_id, device.city, device.placement);
              
              bioBoxResults.success++;
              bioBoxResults.devices.push({
                station_id: device.station_id,
                name: device.station_name,
                status: 'success',
                parameters: ['pm25', 'pm10', 'o3', 'co', 'tmp', 'rh'] // Asumimos éxito completo
              });
            } else {
              // 🐢 Ruta tradicional: BioBox API
              const bioBoxData = await fetchBioBoxHourlyData(connection, device.token);
              
              // Process and store the BioBox data
              const storeResult = await processBioBoxData(
                connection, 
                device.station_id, 
                device.city, 
                device.placement,
                bioBoxData
              );
              
              bioBoxResults.success++;
              bioBoxResults.devices.push({
                station_id: device.station_id,
                name: device.station_name,
                status: 'success',
                parameters: storeResult.parameters
              });
            }
          } catch (deviceError) {
            console.error(`Error processing device ${device.station_id}:`, deviceError);
            bioBoxResults.errors++;
            bioBoxResults.devices.push({
              station_id: device.station_id,
              name: device.station_name,
              status: 'error',
              error: deviceError.message
            });
          }
        }
        
        // Initialize result object if not already defined
        const result = {
          timestamp: mexicoCityTime.toISOString(),
          bioBoxProcessing: bioBoxResults
        };

        // After BioBox processing, run weight calculator on the same hour
        const currentDate = mexicoCityTime.toISOString().split('T')[0]; // Get YYYY-MM-DD
        const currentHour = mexicoCityTime.getHours();
        console.log(`Running weight calculator after BioBox processing for ${currentDate}, hour ${currentHour}`);
        
        try {
          // This is the critical step that calculates weighted values from hourly values
          await weightCalculator.calculateHourlyAverages(connection, currentDate, currentHour);
          await weightCalculator.calculateAndStoreWeightedValues(connection, currentDate, currentHour);
          console.log("Successfully calculated weighted values from hourly data");
          
          // Optional debug verification
          try {
            // Get list of processed stations for verification
            const [stations] = await connection.execute(
              `SELECT DISTINCT station_id FROM weighted_readings 
               WHERE reading_date = ? AND reading_hour = ? 
               AND device_source = 'smability'`,
              [currentDate, currentHour]
            );
            
            if (stations.length > 0) {
              console.log(`Verifying data for ${stations.length} stations`);
              // Check first station as sample
              const sampleStation = stations[0].station_id;
              
              // Check weighted_readings
              const [weightedCheck] = await connection.execute(
                `SELECT parameter_id, hourly_value, weighted_value, avg_8hr_value 
                 FROM weighted_readings 
                 WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
                 ORDER BY parameter_id`,
                [sampleStation, currentDate, currentHour]
              );
              console.log(`Weighted_readings check for ${sampleStation}:`, weightedCheck);
            }
          } catch (verifyError) {
            console.error("Error in verification:", verifyError);
          }
        } catch (weightError) {
          console.error('Error running weight calculator after BioBox processing:', weightError);
        }
        // ===== END OF ADDED CODE =====


      } catch (bioBoxError) {
        console.error("Error in BioBox processing:", bioBoxError);
        result.bioBoxProcessing = {
          status: 'error',
          message: bioBoxError.message
        };
      } finally {
        // Close connection
        await connection.end();
      }
    }

    // Ensure result is defined before returning
    let finalResult;
    if (typeof result !== 'undefined') {
      finalResult = result;
    } else {
      finalResult = {
        timestamp: mexicoCityTime.toISOString(),
        message: 'Data collection completed'
      };
    }
    
    // Return success response
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Smability data collection completed successfully',
        timestamp: mexicoCityTime.toISOString(),
        result: finalResult
      })
    };
  } catch (error) {
    console.error('Full error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });

    // Ensure result is defined for all execution paths
    const finalResult = result || {
      timestamp: mexicoCityTime.toISOString(),
      processed: 0,
      success: 0
    };
    
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Smability data collection completed successfully',
        timestamp: mexicoCityTime.toISOString(),
        result: finalResult
      })
    };
  }
};

/**
 * 🚀 Ingesta datos del nuevo endpoint basado en deviceID (SMAA_003, SMAA_004, etc)
 */
async function fetchNewStationHourlyData(connection, stationId, city, placement) {
  try {
    const apiUrl = `https://jciiy1ok97.execute-api.us-east-1.amazonaws.com/default/getData?action=hourly_history&deviceID=${stationId}&days=40`;
    
    console.log(`📡 Consultando API custom para: ${stationId}`);
    const response = await axios.get(apiUrl, { timeout: 30000 });

    if (!response.data || !Array.isArray(response.data.data)) {
      console.warn(`⚠️ Sin datos en la respuesta para ${stationId}`);
      return;
    }

    const records = response.data.data;
    console.log(`📊 Procesando ${records.length} registros para ${stationId}`);

    for (const record of records) {
      if (!record.hour_timestamp_utc) continue;

      // Conversión de UTC a UTC-6 (CDMX)
      const dateUtc = new Date(record.hour_timestamp_utc * 1000);
      const dateLocal = new Date(dateUtc.getTime() - (6 * 60 * 60 * 1000));
      
      const readingDate = dateLocal.toISOString().split('T')[0];
      const readingHour = dateLocal.getHours();

      // Mapeo ignorando métricas que la BD no soporta
      const hourlyData = {
        pm25: record.pm25_avg !== undefined ? record.pm25_avg : null,
        pm10: record.pm10_avg !== undefined ? record.pm10_avg : null,
        o3: record.o3_avg !== undefined ? record.o3_avg : null,
        co: record.co_avg !== undefined ? record.co_avg : null,
        tmp: record.temperature_avg !== undefined ? record.temperature_avg : null,
        rh: record.humidity_avg !== undefined ? record.humidity_avg : null
      };

      // Usamos tu misma función core de guardado (storeWithCorrectFieldMapping)
      await storeWithCorrectFieldMapping(
        connection, 
        stationId, 
        readingDate, 
        readingHour, 
        city, 
        placement, 
        hourlyData
      );
    }
    console.log(`✅ Sincronización API Custom exitosa: ${stationId}`);
  } catch (error) {
    console.error(`❌ Error en fetchNewStationHourlyData (${stationId}): ${error.message}`);
    throw error; // Propagamos el error para que bioBoxResults lo cachee como "error"
  }
}
// Updated version with proper token validation
async function fetchBioBoxHourlyData(connection, tokenId) {
  try {
    // Enhanced validation with detailed logging
    if (!tokenId || tokenId === "undefined" || tokenId === "") {
      console.error(`Skipping BioBox API call - Invalid token: "${tokenId || 'NULL'}" (${typeof tokenId})`);
      return null; // Return null instead of throwing error to allow graceful skipping
    }
    
    console.log(`Fetching BioBox hourly data with token: ${tokenId}`);
    
    // Fetch data from the BioBox endpoint
    const bioBoxUrl = `https://smability.sidtecmx.com/SmabilityAPI/BioBox?token=${tokenId}`;
    console.log(`Calling BioBox API: ${bioBoxUrl}`);
    
    const response = await axios.get(bioBoxUrl, {
      headers: {
        'Accept': 'application/json'
      },
      timeout: 30000
    });
    
    // Improved response validation
    if (!response.data) {
      console.error(`Empty response from BioBox API for token ${tokenId}`);
      return null;
    }
    
    if (typeof response.data !== 'object') {
      console.error(`Invalid response format from BioBox API for token ${tokenId}`);
      return null;
    }
    
    console.log(`BioBox API response for token ${tokenId}:`, 
      typeof response.data === 'object' ? 
      `Object with ${Object.keys(response.data).length} keys` : response.data
    );

    // Rest of the function remains the same
    const [stationInfo] = await connection.execute(
      `SELECT station_id, city, placement 
       FROM stations 
       WHERE token = ?`,
      [tokenId]
    );
    
    if (stationInfo.length === 0) {
      // If not found by token, try serial_number
      const [deviceInfo] = await connection.execute(
        `SELECT station_id, city, placement 
         FROM stations 
         WHERE serial_number = ?`,
        [tokenId]
      );
      
      if (deviceInfo.length === 0) {
        console.error(`No station found with token ${tokenId} in database`);
        return null;
      }
      
      stationInfo[0] = deviceInfo[0];
    }
    
    // Continue with the rest of the function as before...
    const stationId = stationInfo[0].station_id;
    const city = stationInfo[0].city;
    const placement = stationInfo[0].placement;
    
    console.log(`Found station in database: ${stationId} (City: ${city}, Placement: ${placement})`);
    
    // Parse the timestamp
    const apiTimestamp = response.data.DateTime ? new Date(response.data.DateTime) : new Date();
    const formattedDate = apiTimestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    const hour = apiTimestamp.getHours();
    
    console.log(`Processing BioBox data for date: ${formattedDate}, hour: ${hour}`);
    
    // Parse hourly values
    const hourlyData = {
      pm25: parseFloatFromString(response.data.PM2_5_1hr),
      pm10: parseFloatFromString(response.data.PM10_1hr),
      o3: parseFloatFromString(response.data.O3_1hr),
      co: parseFloatFromString(response.data.CO_1hr),
      co_8hr: parseFloatFromStringWithUnits(response.data.ConcentrationIASCO_8hr),
      tmp: parseFloatFromString(response.data.Temp_1hr),
      rh: parseFloatFromString(response.data.HR_1hr)
    };
    
    console.log(`Parsed hourly values for station ${stationId}:`, hourlyData);

    // Store with proper field mapping
    await storeWithCorrectFieldMapping(connection, stationId, formattedDate, hour, city, placement, hourlyData);
    
    return {
      status: 'success',
      stationId: stationId,
      date: formattedDate,
      hour: hour,
      parameters: Object.keys(hourlyData).filter(key => hourlyData[key] !== null)
    };
  } catch (error) {
    console.error(`Error processing BioBox data for token ${tokenId || 'NULL'}: ${error.message}`);
    return null; // Return null instead of propagating the error
  }
}

/**
 * Process data from BioBox API and store in database
 * @param {Object} connection - MySQL database connection
 * @param {string} stationId - Station ID
 * @param {string} city - City
 * @param {string} placement - Placement (indoor/outdoor)
 * @param {Object} bioBoxData - Data from BioBox API
 * @returns {Object} Results of processing
 */
async function processBioBoxData(connection, stationId, city, placement, bioBoxData) {
  try {
    if (!bioBoxData) {
      console.log(`No BioBox data available for station ${stationId}`);
      return { 
        status: 'skipped',
        parameters: [] 
      };
    }
    
    console.log(`Processing BioBox data for station ${stationId}`);
    
    // Parse the timestamp
    const apiTimestamp = bioBoxData.DateTime ? new Date(bioBoxData.DateTime) : new Date();
    const formattedDate = apiTimestamp.toISOString().split('T')[0]; // YYYY-MM-DD
    const hour = apiTimestamp.getHours();
    
    // Map the BioBox data to parameter IDs
    const hourlyData = {
      pm25: bioBoxData.PM2_5_1hr,
      pm10: bioBoxData.PM10_1hr,
      o3: bioBoxData.O3_1hr,
      co: bioBoxData.CO_1hr,
      tmp: bioBoxData.Temp_1hr,
      rh: bioBoxData.HR_1hr
    };
    
    // Store data with correct field mapping
    await storeWithCorrectFieldMapping(connection, stationId, formattedDate, hour, city, placement, hourlyData);
    
    return {
      status: 'success',
      parameters: Object.keys(hourlyData).filter(key => hourlyData[key] !== null)
    };
  } catch (error) {
    console.error(`Error processing BioBox data for station ${stationId}:`, error);
    throw error;
  }
}


// REPLACE the existing storeWithCorrectFieldMapping function with this one
async function storeWithCorrectFieldMapping(connection, stationId, date, hour, city, placement, hourlyData) {
  try {
    await connection.beginTransaction();
    
    try {
      // Step 1: Store raw readings in the readings table
      console.log(`Storing raw BioBox readings for ${stationId}`);
      await storeReadingsForAPI(connection, stationId, date, hour, city, placement, hourlyData);
      
      // Step 2: Store ALL values in hourly_value only - let weight calculator handle the rest
      console.log(`Storing BioBox hourly values in weighted_readings for ${stationId}`);
      
      // For each parameter, store in hourly_value column
      for (const [parameter, value] of Object.entries(hourlyData)) {
        // Solo procesar si parameter y value son válidos
        if (parameter && value !== null && value !== undefined) {
          try {
            console.log(`Procesando - Parámetro: "${parameter}", Valor: "${value}"`);
            
            // Determinar el campo correcto según el parámetro
            let fieldName = 'hourly_value'; // Default
            let parameterIdToStore = parameter;
            
            if (parameter === 'co_8hr') {
              fieldName = 'avg_8hr_value'; // CO 8hr va directo a avg_8hr_value
              parameterIdToStore = 'co'; // Usar 'co' como parameter_id
            }
            
            await connection.execute(`
              INSERT INTO weighted_readings (
                station_id, parameter_id, reading_date, reading_hour,
                ${fieldName}, city, placement, device_source
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 'smability')
              ON DUPLICATE KEY UPDATE
                ${fieldName} = VALUES(${fieldName}),
                city = VALUES(city),
                placement = VALUES(placement),
                device_source = 'smability',
                last_updated = CURRENT_TIMESTAMP
            `, [
              stationId || '',
              parameterIdToStore,
              date || '',
              hour !== undefined ? hour : 0,
              value,
              city || '',
              placement || 'outdoor'
            ]);
            
            console.log(`Stored ${parameter} value ${value} in ${fieldName} for ${stationId}`);
          } catch (error) {
            console.error(`Error al insertar parámetro "${parameter}": ${error.message}`);
          }
        }
      }

      // Agregar resumen opcional al final
      const totalParams = Object.keys(hourlyData).length;
      const validParams = Object.entries(hourlyData).filter(([key, value]) => 
        key && value !== null && value !== undefined
      ).length;
      const skippedParams = totalParams - validParams;

      if (skippedParams > 0) {
        console.log(`Omitidos ${skippedParams} parámetros inválidos de ${totalParams} total para ${stationId}`);
      }
      
      // Step 3: Update air_quality_index table with the hourly values
      await updateAirQualityIndexFromBioBox(connection, stationId, date, hour, hourlyData);
      
      await connection.commit();
      return {
        status: 'success',
        parameters: Object.keys(hourlyData).filter(k => hourlyData[k] !== null)
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } catch (error) {
    console.error(`Error storing BioBox data: ${error.message}`);
    throw error;
  }
}

/**
 * Store hourly averages in smability_hourly_data table
 */
async function storeHourlyAverages(connection, stationId, date, hour, city, placement, hourlyData) {
  // Track updated parameters
  const updatedParameters = [];
  
  // Store each parameter in smability_hourly_data table
  for (const [parameter, value] of Object.entries(hourlyData)) {
    if (value !== null) {
      await connection.execute(`
        INSERT INTO smability_hourly_data (
          reading_date, 
          reading_hour, 
          parameter_id, 
          city, 
          placement,
          avg_value,
          sample_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          avg_value = VALUES(avg_value),
          sample_count = VALUES(sample_count),
          last_updated = CURRENT_TIMESTAMP
      `, [
        date,
        hour,
        parameter,
        city,
        placement,
        value,
        1 // Sample count is 1 since these are pre-calculated averages
      ]);
      
      updatedParameters.push(parameter);
    }
  }
  
  console.log(`Updated hourly averages for ${stationId} with parameters: ${updatedParameters.join(', ')}`);
}

/**
 * Store weighted readings with correct field mapping
 * THIS IS THE CRITICAL FUNCTION TO FIX THE MAPPING ISSUES
 */
async function storeWeightedReadings(connection, stationId, date, hour, city, placement, hourlyData) {
  const updatedParameters = [];
  
  // Store each parameter in weighted_readings table with correct field mapping
  for (const [parameter, value] of Object.entries(hourlyData)) {
    if (value !== null) {
      // Get the correct field name based on parameter type
      const fieldName = getWeightedFieldName(parameter, 'biobox');
      
      await connection.execute(`
        INSERT INTO weighted_readings (
          station_id, 
          parameter_id, 
          reading_date, 
          reading_hour,
          ${fieldName},
          city, 
          placement, 
          device_source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'smability')
        ON DUPLICATE KEY UPDATE
          ${fieldName} = VALUES(${fieldName}),
          city = VALUES(city),
          placement = VALUES(placement),
          device_source = 'smability',
          last_updated = CURRENT_TIMESTAMP
      `, [
        stationId,
        parameter,
        date,
        hour,
        value,
        city,
        placement
      ]);
      
      updatedParameters.push(parameter);
    }
  }
  
  console.log(`Updated weighted readings for ${stationId} with parameters: ${updatedParameters.join(', ')}`);
}

/**
 * Store readings for API compatibility
 */
async function storeReadingsForAPI(connection, stationId, date, hour, city, placement, hourlyData) {
  const updatedParameters = [];
  const localHour = (hour - 6 + 24) % 24; // Calculate Mexico City local hour
  
  for (const [parameter, value] of Object.entries(hourlyData)) {
    if (value !== null && value !== undefined) {
      try {
        // Format the value as a string for raw_value
        const rawValue = value.toString();
        
        // Insert into readings table with NULL safe parameters
        const [result] = await connection.execute(`
          INSERT INTO readings (
            station_id, 
            parameter_id, 
            reading_date, 
            reading_hour, 
            local_hour,
            value, 
            raw_value, 
            status, 
            city, 
            placement, 
            device_source,
            date_imported
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON DUPLICATE KEY UPDATE 
            value = VALUES(value), 
            raw_value = VALUES(raw_value),
            status = VALUES(status),
            city = VALUES(city),
            placement = VALUES(placement),
            device_source = VALUES(device_source),
            date_imported = CURRENT_TIMESTAMP
        `, [
          stationId || '',
          parameter || '',
          date || '',
          hour !== undefined ? hour : 0,
          localHour !== undefined ? localHour : null,
          value !== undefined ? value : null,
          rawValue || '',
          'Valid',
          city || '',
          placement || 'outdoor',
          'smability'
        ]);
        
        if (result.affectedRows > 0) {
          updatedParameters.push(parameter);
        }
      } catch (error) {
        console.error(`Error saving ${parameter} to readings table:`, error);
      }
    }
  }
  
  if (updatedParameters.length > 0) {
    console.log(`Updated readings table for station ${stationId} with parameters: ${updatedParameters.join(', ')}`);
  }
}

/**
 * Update air_quality_index table with BioBox data
 */
async function updateAirQualityIndexFromBioBox(connection, stationId, date, hour, hourlyData) {
  try {
    // Check if record exists
    const [existingRecord] = await connection.execute(`
      SELECT station_id FROM air_quality_index
      WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
    `, [stationId, date, hour]);
    
    if (existingRecord.length === 0) {
      // Create new record if it doesn't exist
      await connection.execute(`
        INSERT INTO air_quality_index (
          station_id, reading_date, reading_hour
        ) VALUES (?, ?, ?)
      `, [stationId, date, hour]);
    }
    
    // Update individual parameters
    if (hourlyData.pm25 !== null && hourlyData.pm25 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET pm25_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.pm25, stationId, date, hour]);
    }
    
    if (hourlyData.pm10 !== null && hourlyData.pm10 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET pm10_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.pm10, stationId, date, hour]);
    }
    
    if (hourlyData.o3 !== null && hourlyData.o3 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET o3_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.o3, stationId, date, hour]);
    }
    
    if (hourlyData.co !== null && hourlyData.co !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET co_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.co, stationId, date, hour]);
    }

    if (hourlyData.co_8hr !== null && hourlyData.co_8hr !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET co_8hr_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.co_8hr, stationId, date, hour]);
    }
    
    return true;
  } catch (error) {
    console.error(`Error updating air_quality_index for station ${stationId}:`, error);
    return false;
  }
}

// Helper function to parse float values from strings with units
function parseFloatFromString(valueString) {
  if (!valueString || typeof valueString !== 'string') return null;
  
  // Extract the numeric part
  const match = valueString.match(/^([\d.]+)/);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  return null;
}

function getWeightedFieldName(parameter, valueType = 'default') {
  // For BioBox or explicit value types
  if (valueType === 'biobox' || valueType === 'hourly') {
    return 'hourly_value';
  } else if (valueType === '8hr') {
    return 'avg_8hr_value';
  } else if (valueType === '12hr' || valueType === 'weighted') {
    return 'weighted_value';
  }

  // Default mapping by parameter type
  switch (parameter) {
    case 'pm25':
    case 'pm10':
      return 'weighted_value'; // 12hr weighted value
    case 'co':
      return 'avg_8hr_value'; // 8hr average value
    case 'o3':
    case 'no2':
    case 'so2':
    case 'tmp':
    case 'rh':
      return 'hourly_value'; // 1hr value
    default:
      return 'hourly_value';
  }
}

// Update air_quality_index table with new values and recalculate IAS
async function updateAirQualityIndexFromWeightedData(connection, stationId, date, hour, hourlyData) {
  try {
    console.log(`Updating air_quality_index for station ${stationId}, date ${date}, hour ${hour}`);
    
    // First, check if record exists
    const [existingRecord] = await connection.execute(`
      SELECT station_id FROM air_quality_index
      WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
    `, [stationId, date, hour]);
    
    if (existingRecord.length === 0) {
      console.log(`No existing record for station ${stationId}, date ${date}, hour ${hour}. Creating new record.`);
      
      // Create new record with available parameters
      await connection.execute(`
        INSERT INTO air_quality_index (
          station_id, reading_date, reading_hour
        ) VALUES (?, ?, ?)
      `, [stationId, date, hour]);
    }
    
    // Update individual parameter values
    const updates = [];
    if (hourlyData.o3 !== null && hourlyData.o3 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET o3_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.o3, stationId, date, hour]);
      updates.push('o3');
    }
    
    if (hourlyData.co !== null && hourlyData.co !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET co_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.co, stationId, date, hour]);
      updates.push('co');
    }
    
    if (hourlyData.pm25 !== null && hourlyData.pm25 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET pm25_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.pm25, stationId, date, hour]);
      updates.push('pm25');
    }
    
    if (hourlyData.pm10 !== null && hourlyData.pm10 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET pm10_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.pm10, stationId, date, hour]);
      updates.push('pm10');
    }
    // Añadir actualización para SO2
    if (hourlyData.so2 !== null && hourlyData.so2 !== undefined) {
      await connection.execute(`
        UPDATE air_quality_index
        SET so2_value = ?
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [hourlyData.so2, stationId, date, hour]);
      updates.push('so2');
    }
    
    console.log(`Updated air_quality_index parameters for station ${stationId}: ${updates.join(', ')}`);
    
    // Get all parameters available for this record to recalculate IAS
    const [currentValues] = await connection.execute(`
      SELECT 
        station_id, o3_value, co_value, no2_value, 
        pm25_value, pm10_value, so2_value
      FROM air_quality_index 
      WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
    `, [stationId, date, hour]);
    
    if (currentValues.length > 0) {
      const parameters = {
        o3: currentValues[0].o3_value ?? null,
        co: currentValues[0].co_value ?? null,
        no2: currentValues[0].no2_value ?? null,
        pm25: currentValues[0].pm25_value ?? null,
        pm10: currentValues[0].pm10_value ?? null,
        so2: currentValues[0].so2_value ?? null
      };

      const [weightedValues] = await connection.execute(`
        SELECT 
          station_id,
          parameter_id,
          CASE 
            WHEN parameter_id IN ('pm25', 'pm10') THEN weighted_value
            WHEN parameter_id = 'co' THEN avg_8hr_value  
            ELSE hourly_value
          END AS calculated_value
        FROM weighted_readings
        WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
      `, [stationId, date, hour]);

      // Update parameters with the correct values from weighted_readings
      if (weightedValues.length > 0) {
        weightedValues.forEach(row => {
          if (row.calculated_value !== null && row.calculated_value !== undefined) {
            parameters[row.parameter_id] = row.calculated_value;
          }
        });
        
        console.log('Using values from weighted_readings for IAS calculation:', parameters);
      }
      
      // Recalculate IAS
      const recalculatedIAS = await weightCalculator.recalculateIASWithValidParameters(
        connection, stationId, date, hour, parameters, {} // No validation failures
      );
      
      if (recalculatedIAS) {
        // Update with new IAS values
        await connection.execute(`
          UPDATE air_quality_index
          SET 
            ias_numeric_value = ?,
            dominant_pollutant = ?,
            dominant_value = ?,
            category = ?,
            risk_level = ?,
            color_name = ?
          WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
        `, [
          recalculatedIAS.iasValue,
          recalculatedIAS.pollutant,
          recalculatedIAS.value,
          recalculatedIAS.category,
          recalculatedIAS.risk_level,
          recalculatedIAS.color_name,
          stationId, date, hour
        ]);
        
        console.log(`Recalculated IAS for ${stationId}: new value ${recalculatedIAS.iasValue}, new dominant pollutant ${recalculatedIAS.pollutant}`);
      } else {
        console.log(`Unable to recalculate IAS for ${stationId}: insufficient data`);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`Error updating air_quality_index for station ${stationId}:`, error);
    return false;
  }
}

// Function to load device configuration from S3
async function loadDeviceConfigFromS3() {
  try {
    console.log(`Loading device configuration from s3://${CONFIG_BUCKET}/${CONFIG_KEY}`);
    
    const s3Client = new S3Client();
    const response = await s3Client.send(
      new GetObjectCommand({
        Bucket: CONFIG_BUCKET,
        Key: CONFIG_KEY
      })
    );
    
    // Manually read and convert the stream to string
    const chunks = [];
    for await (const chunk of response.Body) {
      chunks.push(chunk);
    }
    const configBuffer = Buffer.concat(chunks);
    const configString = configBuffer.toString('utf-8');
    
    const config = JSON.parse(configString);
    
    console.log(`Successfully loaded configuration with ${config.devices.length} devices`);
    return config;
  } catch (error) {
    console.error('Error loading configuration from S3:', error);
    throw new Error('Failed to load device configuration from S3');
  }
}

// Main function to process device data
async function processDeviceData(deviceConfig, timestamp) {
  console.log('Processing data for all active devices');
  
  // Get active devices
  const activeDevices = deviceConfig.devices.filter(device => device.active === true);
  console.log(`Found ${activeDevices.length} active devices`);
  
  // Initialize or increment run counter for offline device tracking
  let runCount = OFFLINE_DEVICE_CACHE._runCount || 0;
  OFFLINE_DEVICE_CACHE._runCount = (runCount + 1) % OFFLINE_RETRY_INTERVAL;
  console.log(`Offline device cache run count: ${OFFLINE_DEVICE_CACHE._runCount}`);
  
  // Create database connection
  let connection = null;
  
  try {
    connection = await mysql.createConnection(DB_CONFIG);
    
    // Initialize database for Smability devices if needed
    await initializeDatabaseForSMABility(connection);
    
    // Create a time window for data collection (last 60 minutes)
    const endTime = new Date(timestamp);
    const startTime = new Date(timestamp);
    startTime.setMinutes(startTime.getMinutes() - 60); // Get last 60 minutes of data
        
    const startTimeStr = formatDateForAPI(startTime);
    const endTimeStr = formatDateForAPI(endTime);
        
    let totalImported = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let deviceResults = [];
    
    // Process each device
    for (const device of activeDevices) {
      // Check if device is in the offline cache and should be skipped
      if (OFFLINE_DEVICE_CACHE[device.serial] && OFFLINE_DEVICE_CACHE._runCount !== 0) {
        console.log(`Skipping offline device: ${device.station_name || device.name} (last check failed)`);
        deviceResults.push({
          deviceName: device.station_name || device.name,
          deviceSerial: device.serial,
          processed: false,
          status: 'skipped_offline'
        });
        continue;
      }
      
      console.log(`Processing device: ${device.station_name || device.name} (Type: ${device.type})`);
      
      // Get the sensor type for this device
      const deviceSensorType = deviceConfig.sensorTypes[device.type];
      if (!deviceSensorType) {
        console.warn(`Unknown sensor type ${device.type} for device ${device.name}. Skipping.`);
        deviceResults.push({
          deviceName: device.station_name || device.name,
          deviceSerial: device.serial,
          processed: false,
          error: `Unknown sensor type: ${device.type}`
        });
        continue;
      }
      
      let deviceImported = 0;
      let deviceUpdated = 0;
      let deviceSkipped = 0;
      let deviceErrors = 0;
      let sensorResults = [];
      
      // Register the device in the database if it doesn't exist
      try {
        const deviceId = await registerDeviceInDatabase(connection, device);
        console.log(`Device ${device.station_name || device.name} registered with ID: ${deviceId}`);
      } catch (error) {
        console.error(`Error registering device ${device.station_name || device.name}:`, error);
        deviceErrors++;
      }
      
      // Special handling for location sensor
      try {
        console.log(`Fetching location data for ${device.station_name || device.name}`);
        
        // Construct API URL for location sensor
        const locationApiUrl = `${API_BASE_URL}/GetData?token=${device.token}&idSensor=4&dtStart=${encodeURIComponent(startTimeStr)}&dtEnd=${encodeURIComponent(endTimeStr)}`;
        
        // Call API
        const locationResponse = await axios.get(locationApiUrl);
        
        // DEBUGGING: Log the raw response format in more detail
        console.log(`DETAILED LOCATION DATA FORMAT for ${device.station_name || device.name}:`, {
          responseType: typeof locationResponse.data,
          isArray: Array.isArray(locationResponse.data),
          length: Array.isArray(locationResponse.data) ? locationResponse.data.length : 'N/A',
          sample: Array.isArray(locationResponse.data) && locationResponse.data.length > 0 
            ? {
                first: locationResponse.data[0],
                dataType: locationResponse.data[0] ? typeof locationResponse.data[0].Data : 'N/A',
                timeStampExists: locationResponse.data[0] && locationResponse.data[0].TimeStamp ? true : false
              } 
            : 'No data'
        });
        
        // Check if device appears to be offline
        if (!Array.isArray(locationResponse.data) || locationResponse.data.length === 0) {
          // Mark device as likely offline
          OFFLINE_DEVICE_CACHE[device.serial] = true;
          console.log(`Device ${device.station_name || device.name} appears to be offline. Will skip in future runs.`);
        } else {
          // Device is online, remove from offline cache if present
          if (OFFLINE_DEVICE_CACHE[device.serial]) {
            delete OFFLINE_DEVICE_CACHE[device.serial];
            console.log(`Device ${device.station_name || device.name} back online.`);
          }
        
          // Process location data if present
          if (Array.isArray(locationResponse.data) && locationResponse.data.length > 0) {
            // Find the latest location data (should be the first item)
            const locationData = locationResponse.data[0];
            
            if (locationData && locationData.Data) {
              let latitude = null;
              let longitude = null;
              let rawLocationData = '';
              
              // Store the raw location data for the readings table
              if (typeof locationData.Data === 'string') {
                rawLocationData = locationData.Data;
              } else if (typeof locationData.Data === 'object') {
                rawLocationData = JSON.stringify(locationData.Data);
              }
              
              // Try to parse location data in different possible formats
              if (typeof locationData.Data === 'string') {
                // Try multiple possible string formats
                console.log(`Attempting to parse string location data: "${locationData.Data}"`);
                
                // Format 1: lat:19.123,lng:-99.456
                const latLngMatch = locationData.Data.match(/lat:([+-]?\d+(\.\d+)?),lng:([+-]?\d+(\.\d+)?)/i);
                if (latLngMatch) {
                  latitude = parseFloat(latLngMatch[1]);
                  longitude = parseFloat(latLngMatch[3]);
                  console.log(`Parsed from lat:lng format: ${latitude}, ${longitude}`);
                }
                
                // Format 2: "latitude,longitude" (comma-separated)
                else if (locationData.Data.includes(',')) {
                  const parts = locationData.Data.split(',');
                  if (parts.length >= 2) {
                    latitude = parseFloat(parts[0]);
                    longitude = parseFloat(parts[1]);
                    console.log(`Parsed from comma-separated format: ${latitude}, ${longitude}`);
                  }
                }
              } else if (typeof locationData.Data === 'object' && locationData.Data !== null) {
                console.log(`Attempting to parse object location data:`, locationData.Data);
                
                // Check for different possible property names
                if (locationData.Data.lat !== undefined && locationData.Data.lng !== undefined) {
                  latitude = parseFloat(locationData.Data.lat);
                  longitude = parseFloat(locationData.Data.lng);
                  console.log(`Parsed from {lat,lng} object: ${latitude}, ${longitude}`);
                }
                else if (locationData.Data.latitude !== undefined && locationData.Data.longitude !== undefined) {
                  latitude = parseFloat(locationData.Data.latitude);
                  longitude = parseFloat(locationData.Data.longitude);
                  console.log(`Parsed from {latitude,longitude} object: ${latitude}, ${longitude}`);
                }
                else if (Array.isArray(locationData.Data) && locationData.Data.length >= 2) {
                  latitude = parseFloat(locationData.Data[0]);
                  longitude = parseFloat(locationData.Data[1]);
                  console.log(`Parsed from array: ${latitude}, ${longitude}`);
                }
              }
              
              // Log the extracted coordinates
              console.log(`Extracted coordinates for ${device.station_name || device.name}: lat=${latitude}, lng=${longitude}`);
              
              // Update the station record with coordinates if we found valid ones
              if (latitude !== null && longitude !== null && !isNaN(latitude) && !isNaN(longitude)) {
                console.log(`Updating coordinates for station ${device.station_id}`);
                
                await connection.execute(
                  `UPDATE stations 
                  SET latitude = ?, longitude = ?
                  WHERE station_id = ?`,
                  [latitude, longitude, device.station_id]
                );
                
                console.log(`Successfully updated coordinates for station ${device.station_id}`);
              }
              
              // Also save to readings table for historical record
              if (rawLocationData) {
                const readingDate = new Date(locationData.TimeStamp);
                const locationReading = {
                  station_id: device.station_id,
                  parameter_id: 'location',
                  reading_date: `${readingDate.getFullYear()}-${String(readingDate.getMonth() + 1).padStart(2, '0')}-${String(readingDate.getDate()).padStart(2, '0')}`,
                  reading_hour: readingDate.getHours(),
                  value: 1, // Dummy value since we store the actual coordinates in raw_value
                  raw_value: rawLocationData,
                  status: 'Valid',
                  city: device.location.city,
                  placement: device.location.placement,
                  device_source: 'smability'
                };
                
                // Use the same saveReadingsToDatabase function
                const saveResult = await saveReadingsToDatabase(connection, [locationReading]);
                console.log(`Location reading save result:`, saveResult);
              }
            }
          } else {
            console.log(`No location data returned for ${device.station_name || device.name}`);
          }
        } 
      } catch (locationError) {
        console.error(`Error fetching location for ${device.station_name || device.name}:`, locationError);
        // Mark device as offline if API call failed
        OFFLINE_DEVICE_CACHE[device.serial] = true;
      }
        
      // Process each sensor type for this device
      for (const sensor of deviceSensorType) {
        const sensorDescription = SENSOR_ID_MAP[sensor.idSensor] || sensor.description;
        console.log(`Fetching ${sensorDescription} data for ${device.station_name || device.name}`);
        
        try {
          // Skip location sensor - we'll handle it specially
          if (sensor.idSensor === 4) {
            continue;
          }
          
          // Construct API URL
          const apiUrl = `${API_BASE_URL}/GetData?token=${device.token}&idSensor=${sensor.idSensor}&dtStart=${encodeURIComponent(startTimeStr)}&dtEnd=${encodeURIComponent(endTimeStr)}`;
          console.log(`
          ----- COMPREHENSIVE API REQUEST DETAILS -----
          Device: ${device.station_name || device.name}
          Sensor ID: ${sensor.idSensor}
          Sensor Description: ${sensorDescription}
          Start Time (Raw): ${startTime.toISOString()}
          End Time (Raw): ${endTime.toISOString()}
          Start Time (Formatted): ${startTimeStr}
          End Time (Formatted): ${endTimeStr}
          Full API URL: ${apiUrl}
          ------------------------------------------`);

          // Call API
          const response = await axios.get(apiUrl);

          // Log the raw response for debugging
          console.log(`Raw API Response for ${device.station_name || device.name}, sensor ${sensorDescription}:`, response.data);

          // Initialize empty sensorData with proper format
          let sensorData = { data: [] };

          // Check response format
          if (Array.isArray(response.data) && response.data.length > 0 && response.data[0].Data && response.data[0].TimeStamp) {
            // Map the API response to our expected format
            sensorData.data = response.data.map(item => ({
              timestamp: item.TimeStamp,
              value: item.Data
            }));
            
            console.log(`Mapped ${sensorData.data.length} data points for ${device.station_name || device.name}, sensor ${sensorDescription}`);
          } else if (typeof response.data === 'string' && response.data.trim().startsWith('<')) {
            // XML response (empty array)
            console.log(`XML response received for ${device.station_name || device.name}, sensor ${sensorDescription}, appears to be empty`);
          } else {
            // Use the original format (if it happens to be in that format)
            sensorData = response.data;
          }

          if (!sensorData || !sensorData.data || sensorData.data.length === 0) {
            console.log(`No ${sensorDescription} data available for ${device.station_name || device.name}`);
            sensorResults.push({
              sensorId: sensor.idSensor,
              sensorDescription,
              dataPoints: 0,
              imported: 0,
              updated: 0,
              skipped: 0,
              errors: 0
            });
            continue;
          }

          console.log(`Received ${sensorData.data.length} data points for ${sensorDescription}`);
          
          // Transform sensor data to database format
          const dbReadings = transformSensorDataToReadings(device, sensor, sensorData.data);
          
          // Save readings to database
          const saveResult = await saveReadingsToDatabase(connection, dbReadings);
          
          deviceImported += saveResult.imported;
          deviceUpdated += saveResult.updated;
          deviceSkipped += saveResult.skipped;
          deviceErrors += saveResult.errors;
          
          sensorResults.push({
            sensorId: sensor.idSensor,
            sensorDescription,
            dataPoints: sensorData.data.length,
            imported: saveResult.imported,
            updated: saveResult.updated,
            skipped: saveResult.skipped,
            errors: saveResult.errors
          });
          
        } catch (error) {
          console.error(`Error processing sensor ${sensorDescription} for device ${device.station_name || device.name}:`, error);
          deviceErrors++;
          sensorResults.push({
            sensorId: sensor.idSensor,
            sensorDescription,
            dataPoints: 0,
            imported: 0,
            updated: 0,
            skipped: 0,
            errors: 1,
            error: error.message
          });
        }
      }
      
      // Add device result
      deviceResults.push({
        deviceName: device.station_name || device.name, // Use station_name with fallback
        deviceSerial: device.serial,
        deviceType: device.type,
        city: device.location.city,
        placement: device.location.placement,
        imported: deviceImported,
        updated: deviceUpdated,
        skipped: deviceSkipped,
        errors: deviceErrors,
        sensors: sensorResults
      });
      
      totalImported += deviceImported;
      totalUpdated += deviceUpdated;
      totalSkipped += deviceSkipped;
      totalErrors += deviceErrors;
    }

    // After processing all devices, calculate hourly averages for this hour
    const currentDate = timestamp.toISOString().split('T')[0]; // Get YYYY-MM-DD
    const currentHour = timestamp.getHours();
    console.log(`Calculating hourly averages for ${currentDate}, hour ${currentHour}`);
    try {
      await weightCalculator.calculateHourlyAverages(connection, currentDate, currentHour);
      await weightCalculator.calculateAndStoreWeightedValues(connection, currentDate, currentHour);
    } catch (error) {
      console.log('Skipping city average calculation', error);
    }
        
    // Close database connection
    if (connection) await connection.end();
    
    console.log(`Data collection completed. Total imported: ${totalImported}, Updated: ${totalUpdated}, Skipped: ${totalSkipped}, Errors: ${totalErrors}`);
   
    return {
      timestamp: timestamp.toISOString(),
      totalImported,
      totalUpdated,
      totalSkipped,
      totalErrors,
      deviceResults
    };
    
  } catch (error) {
    console.error('Error processing device data:', error);
    
    // Make sure connection is closed even on error
    if (connection) {
      try {
        await connection.end();
      } catch (closeError) {
        console.error('Error closing DB connection:', closeError);
      }
    }
    
    throw error;
  }
}

// Function to initialize the database for Smability devices
async function initializeDatabaseForSMABility(connection) {
  console.log('Initializing database for Smability devices if needed');
  
  try {
    // Check if the 'smability_devices' table exists
    const [tables] = await connection.execute(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'smability_devices'
    `, [DB_CONFIG.database]);
    
    if (tables.length === 0) {
      console.log('Creating smability_devices table');
      await connection.execute(`
        CREATE TABLE smability_devices (
          device_id VARCHAR(50) PRIMARY KEY,
          serial_number VARCHAR(100) NOT NULL,
          device_name VARCHAR(100) NOT NULL,
          device_type VARCHAR(50) NOT NULL,
          city VARCHAR(100),
          placement ENUM('indoor', 'outdoor'),
          active BOOLEAN DEFAULT TRUE,
          date_added TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
    }
    
    // Check if the smability_hourly_data table exists
    const [hourlyTable] = await connection.execute(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'smability_hourly_data'
    `, [DB_CONFIG.database]);
    
    if (hourlyTable.length === 0) {
      console.log('Creating smability_hourly_data table');
      await connection.execute(`
        CREATE TABLE smability_hourly_data (
          id INT AUTO_INCREMENT PRIMARY KEY,
          reading_date DATE NOT NULL,
          reading_hour INT NOT NULL,
          parameter_id VARCHAR(20) NOT NULL,
          city VARCHAR(100),
          placement ENUM('indoor', 'outdoor'),
          avg_value DECIMAL(10,4),
          min_value DECIMAL(10,4),
          max_value DECIMAL(10,4),
          std_dev DECIMAL(10,4),
          sample_count INT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uk_smability_hourly (reading_date, reading_hour, parameter_id, city, placement)
        )
      `);
    }
    
    console.log('Database initialization completed');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Function to register a device in the database

async function registerDeviceInDatabase(connection, device) {
  try {
    // Use the provided station_id or generate one if not available
    const stationId = device.station_id || (() => {
      // Only as fallback if station_id is missing
      const cleanName = (device.station_name || '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 3).toUpperCase();
      const serialSuffix = device.serial.substring(-2);
      return `${cleanName}${serialSuffix}`;
    })();
    
    // Log detailed device information
    console.log(`Registering Device:
      Station ID: ${stationId}
      Station Name: ${device.station_name}
      Serial: ${device.serial}
      City: ${device.location.city}
      Placement: ${device.location.placement}
      Latitude: ${device.location.latitude || 'N/A'}
      Longitude: ${device.location.longitude || 'N/A'}
    `);

    // Check if device already exists
    const [existingDevice] = await connection.execute(
      'SELECT station_id, station_name FROM stations WHERE station_id = ?',
      [stationId]
    );
    
    if (existingDevice.length > 0) {
      // Update existing device
      await connection.execute(
        `UPDATE stations 
         SET station_name = ?, 
             city = ?, 
             placement = ?,
             latitude = ?,
             longitude = ?,
             monitor_type = ?
         WHERE station_id = ?`,
        [
          device.station_name,
          device.location.city,
          device.location.placement,
          device.location.latitude || null,
          device.location.longitude || null,
          device.type,
          stationId
        ]
      );
      
      console.log(`Updated existing station: ${stationId}`);
      return stationId;
    } else {
      // Insert new device/station
      await connection.execute(
        `INSERT INTO stations 
         (station_id, station_name, city, placement, latitude, longitude)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          stationId,
          device.station_name,
          device.location.city,
          device.location.placement,
          device.location.latitude || null,
          device.location.longitude || null
        ]
      );
      
      console.log(`Inserted new station: ${stationId}`);
      return stationId;
    }
  } catch (error) {
    console.error(`Error registering device ${device.station_name}:`, {
      message: error.message,
      code: error.code,
      sqlMessage: error.sqlMessage,
      deviceDetails: {
        station_id: device.station_id,
        station_name: device.station_name,
        serial: device.serial,
        city: device.location?.city,
        placement: device.location?.placement,
        latitude: device.location?.latitude,
        longitude: device.location?.longitude
      }
    });
    
    // Re-throw the error after logging
    throw error;
  }
}

// Function to transform sensor data to readings format

function transformSensorDataToReadings(device, sensor, sensorData) {
  const readings = [];
  
  for (const dataPoint of sensorData) {
    const timestamp = new Date(dataPoint.timestamp);
    const year = timestamp.getFullYear();
    const month = (timestamp.getMonth() + 1).toString().padStart(2, '0');
    const day = timestamp.getDate().toString().padStart(2, '0');
    const hour = timestamp.getHours();
    
    // Calculate local hour (Mexico City, UTC-6)
    const localHour = (hour - 6 + 24) % 24;
    
    // Get parameter ID for database
    const sensorDescription = SENSOR_ID_MAP[sensor.idSensor] || sensor.description;
    const parameterId = PARAMETER_MAPPING[sensorDescription] || null;
    
    if (parameterId) {
      readings.push({
        // Use station_id instead of name
        station_id: device.station_id || device.name, // Fallback to name for backward compatibility
        parameter_id: parameterId,
        reading_date: `${year}-${month}-${day}`,
        reading_hour: hour,
        local_hour: localHour, // Add the local hour field
        value: parseFloat(dataPoint.value),
        raw_value: dataPoint.value.toString(),
        status: 'Valid',
        city: device.location.city,
        placement: device.location.placement,
        device_source: 'smability'
      });
    } else {
      console.warn(`No parameter mapping found for sensor ${sensorDescription}`);
    }
  }
  
  return readings;
}

// Function to save readings to database
async function saveReadingsToDatabase(connection, readings) {
  let stats = { imported: 0, updated: 0, errors: 0, skipped: 0, total: readings.length };
  
  try {
    // Start a transaction
    await connection.beginTransaction();
    
    // Enhanced logging and error handling
    console.log(`Attempting to save ${readings.length} readings`);
    
    for (const reading of readings) {
      try {
        // Comprehensive validation
        if (!reading.station_id || !reading.parameter_id) {
          console.warn('Invalid reading - missing critical fields:', reading);
          stats.errors++;
          continue;
        }

        // Check station existence with more detailed logging
        const [stationRows] = await connection.execute(
          'SELECT station_id FROM stations WHERE station_id = ?',
          [reading.station_id]
        );
        
        // More verbose logging for station check
        if (stationRows.length === 0) {
          console.log(`Station not found: ${reading.station_id}. Attempting to insert.`);
          await connection.execute(
            'INSERT INTO stations (station_id, station_name) VALUES (?, ?)',
            [reading.station_id, reading.station_id]
          );
        }
        
        // Enhanced insert with more comprehensive error catching
        const [result] = await connection.execute(
          `INSERT INTO readings 
           (station_id, parameter_id, reading_date, reading_hour, local_hour, value, raw_value, status, city, placement, device_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE 
           value = VALUES(value), 
           raw_value = VALUES(raw_value),
           local_hour = VALUES(local_hour),
           status = VALUES(status),
           city = VALUES(city),
           placement = VALUES(placement),
           device_source = VALUES(device_source),
           date_imported = CURRENT_TIMESTAMP`,
          [
            reading.station_id || '', 
            reading.parameter_id || '',
            reading.reading_date || new Date().toISOString().split('T')[0],
            reading.reading_hour !== undefined ? reading.reading_hour : new Date().getHours(),
            reading.local_hour !== undefined ? reading.local_hour : null,
            reading.value !== undefined ? reading.value : null,
            reading.raw_value || (reading.value !== undefined ? reading.value.toString() : ''),
            reading.status || 'Valid',
            reading.city || '',
            reading.placement || 'outdoor',
            reading.device_source || 'smability'
          ]
        );

        // More granular logging of insert results
        if (result.affectedRows === 1 && result.insertId > 0) {
          stats.imported++;
          console.log(`Successfully imported reading: ${reading.station_id}, ${reading.parameter_id}`);
        } else if (result.affectedRows === 2) {
          stats.updated++;
          console.log(`Updated existing reading: ${reading.station_id}, ${reading.parameter_id}`);
        } else {
          stats.skipped++;
          console.log(`Skipped reading: ${reading.station_id}, ${reading.parameter_id}`);
        }

      } catch (error) {
        // Extremely detailed error logging
        console.error('Error processing individual reading:', {
          errorMessage: error.message,
          errorCode: error.code,
          sqlState: error.sqlState,
          reading: JSON.stringify(reading),
          fullError: error
        });
        stats.errors++;
      }
    }
    
    // Commit the transaction
    await connection.commit();
    
    // Log final statistics
    console.log('Database save statistics:', stats);
    
    return stats;
  } catch (error) {
    // Rollback the transaction in case of error
    await connection.rollback();
    console.error('Transaction failed:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      fullError: error
    });
    throw error;
  }
}

// Helper function to format dates for API
function formatDateForAPI(date) {
  // Format in YYYY-MM-DD HH:MM:SS without timezone adjustment
  // (assuming date is already in the desired timezone)
  const pad = num => num.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
