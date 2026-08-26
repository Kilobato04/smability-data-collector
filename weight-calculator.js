/**
 * Enhanced Weight Calculator Module for the Smability Air Quality System 
 * This module calculates hourly averages and weighted averages for air quality readings from Smability devices.
 * 
 * This file is part of the main Lambda function deployment package.
 */

// Configuration constants for weighted calculations
const CALCULATION_CONFIG = {
  pm25: {
    factorA: 0.694,
    coefficient: 55.80,
    timespan: 12,
    hourlyRequired: true
  },
  pm10: {
    factorA: 0.714,
    coefficient: 50.04,
    timespan: 12,
    hourlyRequired: true
  },
  co: {
    timespan: 8,
    hourlyRequired: true
  },
  o3: {
    timespan: 1,
    hourlyRequired: true
  },
  no2: {
    timespan: 1,
    hourlyRequired: true
  },
  so2: {
    timespan: 1,
    hourlyRequired: true
  },
  tmp: {
    timespan: 1,
    hourlyRequired: true
  },
  rh: {
    timespan: 1,
    hourlyRequired: true
  }
};

/**
 * Calculate and store hourly averages for Smability devices
 * 
 * @param {Object} connection - MySQL database connection
 * @param {string} date - Date in YYYY-MM-DD format
 * @param {number} hour - Hour (0-23)
 * @returns {Object} Results of the calculation
 */
async function calculateHourlyAverages(connection, date, hour) {
  console.log(`Calculating hourly averages for Smability devices: ${date}, hour ${hour}`);
  
  let calculationsPerformed = 0;
  let recordsUpdated = 0;
  
  try {
    // Get all Smability readings for the specified date/hour
    const [readings] = await connection.execute(`
      SELECT 
        station_id, 
        parameter_id, 
        value,
        city,
        placement
      FROM 
        readings
      WHERE 
        reading_date = ? 
        AND reading_hour = ?
        AND device_source = 'smability'
        AND value IS NOT NULL
    `, [date, hour]);
    
    console.log(`Found ${readings.length} Smability readings for hourly average calculation`);
    
    // Group readings by city, parameter and placement
    const groupedReadings = {};
    
    for (const reading of readings) {
      const { city, parameter_id, placement } = reading;
      
      // Create group key
      const groupKey = `${city}_${parameter_id}_${placement}`;
      
      if (!groupedReadings[groupKey]) {
        groupedReadings[groupKey] = {
          city,
          parameter_id,
          placement,
          values: []
        };
      }
      
      groupedReadings[groupKey].values.push(parseFloat(reading.value));
    }
    
    // Calculate averages for each group
    for (const [groupKey, group] of Object.entries(groupedReadings)) {
      calculationsPerformed++;
      
      if (group.values.length === 0) {
        continue;
      }
      
      // Calculate statistics
      const sum = group.values.reduce((acc, val) => acc + val, 0);
      const average = sum / group.values.length;
      
      // Calculate standard deviation
      const squaredDifferences = group.values.map(val => Math.pow(val - average, 2));
      const avgSquaredDiff = squaredDifferences.reduce((acc, val) => acc + val, 0) / group.values.length;
      const stdDev = Math.sqrt(avgSquaredDiff);
      
      // Find min and max
      const min = Math.min(...group.values);
      const max = Math.max(...group.values);
      
      // Store the hourly average in smability_hourly_data table
      await connection.execute(`
        INSERT INTO smability_hourly_data (
          reading_date, 
          reading_hour, 
          parameter_id, 
          city, 
          placement,
          avg_value,
          min_value,
          max_value,
          std_dev,
          sample_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          avg_value = VALUES(avg_value),
          min_value = VALUES(min_value),
          max_value = VALUES(max_value),
          std_dev = VALUES(std_dev),
          sample_count = VALUES(sample_count),
          last_updated = CURRENT_TIMESTAMP
      `, [
        date,
        hour,
        group.parameter_id,
        group.city,
        group.placement,
        average,
        min,
        max,
        stdDev,
        group.values.length
      ]);
      
      recordsUpdated++;
      
      console.log(`Calculated hourly average for ${group.city}, ${group.parameter_id}: ${average.toFixed(3)} (${group.values.length} samples)`);
    }
    
    return {
      date,
      hour,
      calculationsPerformed,
      recordsUpdated,
      message: 'Hourly averages calculated successfully'
    };
  } catch (error) {
    console.error('Error calculating hourly averages:', error);
    throw error;
  }
}

/**
 * Calculate and store weighted values for Smability devices
 */
async function calculateAndStoreWeightedValues(connection, date, hour) {
  console.log(`Calculating weighted values for Smability devices: ${date}, hour ${hour}`);
  
  const stationValidationResults = {};

  const results = {
    parametersProcessed: 0,
    calculationsPerformed: 0,
    recordsUpdated: 0,
    errors: 0,
    parameterResults: []
  };
  
  try {
    // First, get a mapping of device serials to station_ids from the stations table
    const [stationMappings] = await connection.execute(`
      SELECT station_id, city, placement
      FROM stations
      WHERE monitor_type IS NULL OR monitor_type LIKE '%SMAA%'
    `);
    
    // Create a map for quick lookup
    const stationMap = {};
    for (const station of stationMappings) {
      stationMap[station.station_id] = {
        city: station.city,
        placement: station.placement
      };
    }
    
    // Process each parameter with its specific calculation method
    for (const [parameter, config] of Object.entries(CALCULATION_CONFIG)) {
      try {
        console.log(`Processing weighted calculations for ${parameter}`);
        results.parametersProcessed++;
        
        // Get hourly data for this parameter
        const [hourlyData] = await connection.execute(`
          SELECT 
            h.reading_date,
            h.reading_hour,
            h.parameter_id,
            h.city,
            h.placement,
            h.avg_value,
            s.station_id AS device_serial
          FROM 
            smability_hourly_data h
          JOIN
            stations s ON s.city = h.city AND s.placement = h.placement
          WHERE 
            h.parameter_id = ? AND
            h.reading_date = ? AND 
            h.reading_hour = ?
        `, [parameter, date, hour]);
        
        if (!hourlyData || hourlyData.length === 0) {
          console.log(`No hourly data available for ${parameter}. Skipping.`);
          results.parameterResults.push({
            parameter,
            calculationsPerformed: 0,
            recordsUpdated: 0,
            error: 'No hourly data available'
          });
          continue;
        }
        
        // Group data by device serial
        const deviceData = {};
        for (const reading of hourlyData) {
          const deviceSerial = reading.device_serial;
          
          if (!deviceData[deviceSerial]) {
            deviceData[deviceSerial] = {
              readings: [],
              city: reading.city,
              placement: reading.placement
            };
          }
          
          deviceData[deviceSerial].readings.push(reading);
        }
        
        let parameterStats = {
          parameter,
          calculationsPerformed: 0,
          recordsUpdated: 0,
          errors: 0
        };

        // Add this new line
        // Store validation results for each station
        const stationValidationResults = {};
        
        // For each device, get historical data and calculate weighted values
        for (const [deviceSerial, data] of Object.entries(deviceData)) {
          try {
            // Get historical data based on the timespan
            // Properly handle the timespan parameter to avoid SQL errors
            let timespan = 1; // Safe default
            try {
              // Ensure it's a positive integer
              timespan = Math.max(1, parseInt(config.timespan || 1, 10));
              if (isNaN(timespan)) timespan = 1;
            } catch (e) {
              console.warn(`Error parsing timespan: ${e.message}, using default value 1`);
            }

            // Instead of using LIMIT ? as a parameter
            const [historicalData] = await connection.execute(`
              SELECT 
                reading_date,
                reading_hour,
                parameter_id,
                avg_value
              FROM 
                smability_hourly_data
              WHERE 
                parameter_id = ? AND
                city = ? AND
                placement = ? AND
                station_id = ? AND 
                ((reading_date = ? AND reading_hour <= ?) OR 
                (reading_date = DATE_SUB(?, INTERVAL 1 DAY) AND reading_hour > ?))
              ORDER BY 
                reading_date DESC, reading_hour DESC
              LIMIT ${timespan}
            `, [
              parameter || '', 
              data.city || '',
              data.placement || 'outdoor',
              deviceSerial,  
              date, 
              parseInt(hour, 10) || 0, 
              date, 
              parseInt(24 - (config.timespan || 0), 10)
            ]);
            
            if (!historicalData || historicalData.length === 0) {
              console.log(`No sufficient historical data for device ${deviceSerial}, parameter ${parameter}`);
              continue;
            }
            
            let weightedValue = null;

            let validationFailed = false;
            
            // Apply the appropriate calculation based on parameter
            // Apply the appropriate calculation based on parameter
            switch (parameter) {
              case 'pm25':
              case 'pm10':
                weightedValue = calculateParticleWeightedValue(historicalData, config);
                if (weightedValue !== null) {
                  // Store weighted value in the weighted_value field
                  await storeWeightedValue(connection, deviceSerial, parameter, date, hour, weightedValue, data.city, data.placement);
                }
                break;
                
                case 'co':
                  // Verificar si ya tenemos el valor de CO 8hr del BioBox
                  const [existingCO8hr] = await connection.execute(`
                    SELECT avg_8hr_value FROM weighted_readings
                    WHERE station_id = ? AND parameter_id = 'co' AND reading_date = ? AND reading_hour = ?
                    AND avg_8hr_value IS NOT NULL
                  `, [deviceSerial, date, hour]);
                  
                  if (existingCO8hr.length > 0 && existingCO8hr[0].avg_8hr_value !== null) {
                    console.log(`CO 8hr value already exists from BioBox for ${deviceSerial}: ${existingCO8hr[0].avg_8hr_value}`);
                    // No calcular, usar el valor del BioBox
                    weightedValue = existingCO8hr[0].avg_8hr_value;
                  } else {
                    // Calcular solo si no existe el valor del BioBox
                    console.log(`Calculating CO 8hr for ${deviceSerial} (no BioBox data available)`);
                    weightedValue = calculateAverageValue(historicalData, config.timespan);
                    if (weightedValue !== null) {
                      await storeWeightedValue(connection, deviceSerial, parameter, date, hour, weightedValue, data.city, data.placement);
                    }
                  }
                  break;
                
              case 'o3':
                // Try to get current hour data first - with station_id filter
                const [ozoneData] = await connection.execute(`
                  SELECT 
                    reading_date,
                    reading_hour,
                    parameter_id,
                    avg_value
                  FROM 
                    smability_hourly_data
                  WHERE 
                    parameter_id = 'o3' AND
                    city = ? AND
                    placement = ? AND
                    station_id = ? AND
                    reading_date = ? AND 
                    reading_hour = ?
                  LIMIT 1
                `, [data.city, data.placement, deviceSerial, date, hour]);
                
                // Get ozone value
                const ozoneReading = ozoneData[0];
                if (ozoneReading && ozoneReading.avg_value !== null && ozoneReading.avg_value !== undefined) {
                  // Asegurarse que es un número antes de usar toFixed
                  const numericValue = parseFloat(ozoneReading.avg_value);
                  if (!isNaN(numericValue)) {
                    weightedValue = parseFloat(numericValue.toFixed(3));
                  } else {
                    console.log(`Valor no numérico para ozono: ${ozoneReading.avg_value}`);
                    weightedValue = null;
                  }
                } else {
                  weightedValue = null;
                }
                
                // Store ozone value
                if (weightedValue !== null) {
                  await storeWeightedValue(connection, deviceSerial, parameter, date, hour, weightedValue, data.city, data.placement);
                }
                break;
                
              case 'no2':
              case 'so2':
              case 'tmp':
              case 'rh':
                // For these parameters, ensure they're stored in hourly_value field
                // This should be handled automatically by storeWeightedValue
                await storeWeightedValue(connection, deviceSerial, parameter, date, hour, hourlyData[0]?.avg_value, data.city, data.placement);
                break;
            }
            
            // Only update database if we calculated a value
            if (weightedValue !== null) {
              parameterStats.calculationsPerformed++;
              results.calculationsPerformed++;
              
              // Store the weighted value
              const storeResult = await storeWeightedValue(
                connection,
                deviceSerial,
                parameter,
                date,
                hour,
                weightedValue,
                data.city,
                data.placement
              );
              
              if (storeResult) {
                parameterStats.recordsUpdated++;
                results.recordsUpdated++;
              }
            }
          } catch (deviceError) {
            console.error(`Error processing device ${deviceSerial}, parameter ${parameter}:`, deviceError);
            parameterStats.errors++;
            results.errors++;
          }
        }
        
        results.parameterResults.push(parameterStats);
      } catch (paramError) {
        console.error(`Error processing parameter ${parameter}:`, paramError);
        results.errors++;
        results.parameterResults.push({
          parameter,
          calculationsPerformed: 0,
          recordsUpdated: 0,
          error: paramError.message
        });
      }
    }
    
    // Update air_quality_index table with weighted values
    console.log(`Updating air_quality_index table for date ${date}, hour ${hour}...`);

    // Get all the weighted values for this hour
    const [weightedValues] = await connection.execute(`
      SELECT station_id, parameter_id, hourly_value, weighted_value, avg_8hr_value
      FROM weighted_readings
      WHERE reading_date = ? AND reading_hour = ?
    `, [date, hour]);

    // Group by station
    const stationValues = {};
    for (const row of weightedValues) {
      if (!stationValues[row.station_id]) {
        stationValues[row.station_id] = {};
      }
      
      // Store each parameter's value in the appropriate field
      const fieldName = getWeightedFieldName(row.parameter_id);
      stationValues[row.station_id][row.parameter_id] = row[fieldName];
    }

    // Now update air_quality_index for each station
    let updated = 0;
    for (const [stationId, params] of Object.entries(stationValues)) {
      // Update the air_quality_index table with the values from weighted_readings
      try {
        // Check if record exists
        const [existingRecord] = await connection.execute(`
          SELECT station_id FROM air_quality_index
          WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
        `, [stationId, date, hour]);
        
        if (existingRecord.length > 0) {
          // Check if this station had PM validation failures
          const hasValidationFailure = (stationValidationResults && 
            stationValidationResults[stationId] && 
            (stationValidationResults[stationId]?.pm25 || stationValidationResults[stationId]?.pm10)) || false;
            
          // Check if the dominant pollutant is one that failed validation
          const dominantPollutant = existingRecord[0].dominant_pollutant;
          const isDominantPollutantInvalid = dominantPollutant && 
            stationValidationResults && 
            stationValidationResults[stationId] && 
            dominantPollutant in (stationValidationResults[stationId] || {});
          
          // If we need to recalculate IAS because PM readings were invalid
          if (hasValidationFailure && isDominantPollutantInvalid) {
            console.log(`Recalculating IAS for station ${stationId} because dominant pollutant ${dominantPollutant} has invalid readings`);
            
            // Recalculate IAS based on valid parameters
            const recalculatedIAS = await recalculateIASWithValidParameters(
              connection, stationId, date, hour, stationValues[stationId], stationValidationResults[stationId]
            );
            
            if (recalculatedIAS) {
              // Update air_quality_index with new IAS value and dominant pollutant
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
              
              console.log(`Updated IAS for station ${stationId}: new value ${recalculatedIAS.iasValue}, new dominant pollutant ${recalculatedIAS.pollutant}`);
            }
          } else {
            // Original code for updating just the o3 value
            await connection.execute(`
              UPDATE air_quality_index
              SET 
                o3_value = ?
              WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
            `, [
              params.o3 || null, // Use the weighted o3 value
              stationId, date, hour
            ]);
          }
          updated++;
        }
      } catch (error) {
        console.error(`Error updating air_quality_index for station ${stationId}:`, error);
      }
    }

    console.log(`Updated o3_value in air_quality_index for ${updated} stations`);
    
    return results;
  } catch (error) {
    console.error('Error in calculateAndStoreWeightedValues:', error);
    throw error;
  }
}

/**
 * Calculate weighted value for PM2.5 or PM10 using time-weighted average
 * with added validation for impossible readings
 * 
 * @param {Array} readings - Historical readings for a station
 * @param {Object} config - Calculation configuration
 * @returns {Number|null} Weighted value or null if conditions not met
 */
function calculateParticleWeightedValue(readings, config) {
  try {
    if (!readings || readings.length === 0) {
      console.log("No readings provided, returning null");
      return null;
    }
    // Verificar si hay al menos algunas lecturas válidas
    const validReadingsExist = readings.some(r => 
      r.avg_value !== null && 
      r.avg_value !== undefined && 
      !isNaN(parseFloat(r.avg_value))
    );

    if (!validReadingsExist) {
      console.log("No valid readings available, returning null");
      return null;
    }
    
    // Sort readings by date and hour (most recent first)
    const sortedReadings = [...readings].sort((a, b) => {
      // First compare dates
      const dateA = new Date(a.reading_date);
      const dateB = new Date(b.reading_date);
      
      if (dateA.getTime() !== dateB.getTime()) {
        return dateB.getTime() - dateA.getTime();
      }
      
      // If dates are the same, compare hours
      return b.reading_hour - a.reading_hour;
    });
    
    // ===== VALIDATION LOGIC START =====
    // Define realistic maximum thresholds
    const PM25_MAX_THRESHOLD = 1000; // μg/m³
    const PM10_MAX_THRESHOLD = 2000; // μg/m³
    
    // Determine which particle type we're processing
    const isPM25 = config.factorA === 0.694;
    const isPM10 = config.factorA === 0.714;
    const paramName = isPM25 ? 'PM2.5' : isPM10 ? 'PM10' : 'Unknown particle';
    const maxThreshold = isPM25 ? PM25_MAX_THRESHOLD : isPM10 ? PM10_MAX_THRESHOLD : Number.MAX_VALUE;
    
    // Filter out impossible readings
    const validatedReadings = sortedReadings.map(reading => {
      if (reading.avg_value === null || reading.avg_value === undefined) {
        return reading; // Keep nulls as-is
      }
      
      const value = parseFloat(reading.avg_value);
      
      // Check if the value exceeds the threshold
      if (value > maxThreshold) {
        console.log(`VALIDATION FAILED: ${paramName} reading (${value}) exceeds maximum threshold (${maxThreshold}) for date ${reading.reading_date}, hour ${reading.reading_hour}`);
        // Return a copy with null value to maintain the position in the array
        return { ...reading, avg_value: null, validation_failed: true };
      }
      
      return reading; // Keep valid readings
    });
    
    // Check if we have any valid readings left
    const hasValidReadings = validatedReadings.some(r => r.avg_value !== null && r.avg_value !== undefined);
    
    if (!hasValidReadings) {
      console.log(`No valid ${paramName} readings after validation, returning null`);
      return null;
    }
    // ===== VALIDATION LOGIC END =====
    
    // Check if we have data in the last 3 monitored hours
    let hasRecentData = false;
    for (let i = 0; i < Math.min(3, validatedReadings.length); i++) {
      if (validatedReadings[i]?.avg_value !== null && validatedReadings[i]?.avg_value !== undefined) {
        hasRecentData = true;
        break;
      }
    }
    
    if (!hasRecentData) {
      console.log(`No data available for the last 3 monitored hours of ${paramName}, returning null`);
      return null;
    }
    
    // Extract all available values, preserving their order (most recent first)
    const valuesWithNulls = validatedReadings.map(r => r.avg_value);
    
    // Filter out nulls for calculations
    const validValues = valuesWithNulls.filter(v => v !== null && v !== undefined);
    
    if (validValues.length === 0) {
      console.log(`No valid values found for ${paramName}, returning null`);
      return null;
    }
    
    // Step 1: Find the maximum and minimum values
    const maxValue = Math.max(...validValues);
    const minValue = Math.min(...validValues);
    
    // Step 2: Calculate the range
    const range = maxValue - minValue;
    
    // Step 3: Calculate W1 (weight factor)
    let w1 = 1 - (range / maxValue);
    w1 = Math.max(0.5, w1); // W1 should be at least 0.5
    
    // Get factorA from config
    const factorA = config.factorA;
    
    // Calculate Wexp12 (sum of W1^i from i=0 to 11)
    let wexp12 = 0;
    for (let i = 0; i <= 11; i++) {
      wexp12 += Math.pow(w1, i);
    }
    
    // Calculate the weighted sum using W1
    let weightedSum = 0;
    
    // Build an array of the most recent 12 readings, keeping nulls as null
    const recentValues = valuesWithNulls.slice(0, 12);
    
    // Process each of the recent values in order (most recent first)
    for (let i = 0; i < recentValues.length; i++) {
      // Skip null values in the calculation but maintain position for weight
      if (recentValues[i] === null || recentValues[i] === undefined) {
        continue;
      }
      
      const weight = Math.pow(w1, i);
      weightedSum += weight * recentValues[i];
    }
    
    // Calculate final weighted value
    const weightedValue = (weightedSum / wexp12) * factorA;
    
    return weightedValue;
  } catch (error) {
    console.error(`Error in calculateParticleWeightedValue:`, error);
    // Return null on error
    return null;
  }
}


/**
 * Calculate average value for CO (8-hour) or other parameters
 * 
 * @param {Array} readings - Historical readings for a station
 * @param {Number} timespan - Timespan to average over
 * @returns {Number|null} Average value or null if not enough data
 */
function calculateAverageValue(readings, timespan) {
  // Filter out null values
  const validReadings = readings.filter(r => r.avg_value !== null && r.avg_value !== undefined);
  
  // For CO, we need at least 4 hours of data
  const minReadings = 4;
  
  if (validReadings.length < minReadings) {
    console.log(`Not enough valid readings: ${validReadings.length} < ${minReadings}`);
    return null;
  }
  
  // Sort readings by date and hour (most recent first)
  const sortedReadings = [...validReadings].sort((a, b) => {
    // First compare dates
    const dateA = new Date(a.reading_date);
    const dateB = new Date(b.reading_date);
    
    if (dateA.getTime() !== dateB.getTime()) {
      return dateB.getTime() - dateA.getTime();
    }
    
    // If dates are the same, compare hours
    return b.reading_hour - a.reading_hour;
  });
  
  // Take only the most recent readings (up to timespan)
  const recentReadings = sortedReadings.slice(0, timespan);
  
  // Calculate the average
  const sum = recentReadings.reduce((total, reading) => total + parseFloat(reading.avg_value), 0);
  const average = sum / recentReadings.length;
  
  return parseFloat(average.toFixed(2));
}

/**
 * Store weighted value in the database
 */
async function storeWeightedValue(connection, stationId, parameter, date, hour, value, city, placement) {
  try {
    console.log(`Storing ${parameter} weighted value for station ${stationId}`);
    
    // Determine the correct field to update based on parameter
    const fieldName = getWeightedFieldName(parameter);
    
    // Check if record exists with hourly value
    const [existingRecord] = await connection.execute(
      `SELECT id, hourly_value FROM weighted_readings 
       WHERE station_id = ? AND parameter_id = ? AND reading_date = ? AND reading_hour = ?`,
      [stationId, parameter, date, hour]
    );
    
    if (existingRecord.length > 0) {
      // Update the weighted value field while preserving hourly value
      await connection.execute(
        `UPDATE weighted_readings 
         SET ${fieldName} = ?, 
             city = ?,
             placement = ?,
             device_source = 'smability',
             last_updated = CURRENT_TIMESTAMP
         WHERE station_id = ? AND parameter_id = ? AND reading_date = ? AND reading_hour = ?`,
        [value, city, placement, stationId, parameter, date, hour]
      );
    } else {
      // For new records, determine which fields to set
      const fields = ['station_id', 'parameter_id', 'reading_date', 'reading_hour', fieldName, 'city', 'placement', 'device_source'];
      const values = [stationId, parameter, date, hour, value, city, placement, 'smability'];
      
      // Create placeholders for INSERT
      const placeholders = fields.map(() => '?').join(', ');
      
      await connection.execute(
        `INSERT INTO weighted_readings (${fields.join(', ')})
         VALUES (${placeholders})`,
        values
      );
    }
    
    return true;
  } catch (error) {
    console.error(`Error storing weighted value for ${parameter}:`, error);
    return false;
  }
}

/**
 * Recalculate IAS value using valid parameters when PM readings are invalid
 * 
 * @param {Object} connection - Database connection
 * @param {String} stationId - Station ID
 * @param {String} date - Reading date
 * @param {Number} hour - Reading hour
 * @param {Object} parameters - Parameter values
 * @param {Object} validationResults - Validation results for parameters
 * @returns {Object|null} Recalculated IAS information or null if not possible
 */
async function recalculateIASWithValidParameters(connection, stationId, date, hour, parameters, validationResults) {
  try {
    console.log(`Recalculating IAS for station ${stationId} using valid parameters`);
    console.log(`Available parameters:`, parameters);
    console.log(`Validation results:`, validationResults);
    
    // Define IAS breakpoints and associated categories for each pollutant
    const iasBreakpoints = {
      o3: [
        { min: 0, max: 58, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 59, max: 90, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 91, max: 135, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 136, max: 175, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 176, max: 404, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 405, max: 604, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ],
      co: [
        { min: 0, max: 5000, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 5001, max: 9000, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 9001, max: 12000, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 12001, max: 16000, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 16001, max: 20000, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 20001, max: 30000, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ],
      no2: [
        { min: 0, max: 53, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 54, max: 106, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 107, max: 160, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 161, max: 213, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 214, max: 400, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 401, max: 600, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ],
      so2: [
        { min: 0, max: 35, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 36, max: 75, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 76, max: 185, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 186, max: 304, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 305, max: 604, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 605, max: 1004, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ],
      pm25: [
        { min: 0, max: 15, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 16, max: 33, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 34, max: 79, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 80, max: 130, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 131, max: 250, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 251, max: 350, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ],
      pm10: [
        { min: 0, max: 15, iasMin: 0, iasMax: 50, category: 'Buena', risk_level: 'Bajo', color_name: 'Verde' },
        { min: 16, max: 33, iasMin: 51, iasMax: 100, category: 'Regular', risk_level: 'Moderado', color_name: 'Amarillo' },
        { min: 34, max: 79, iasMin: 101, iasMax: 150, category: 'Mala', risk_level: 'Alto', color_name: 'Naranja' },
        { min: 80, max: 130, iasMin: 151, iasMax: 200, category: 'Muy Mala', risk_level: 'Muy Alto', color_name: 'Rojo' },
        { min: 131, max: 250, iasMin: 201, iasMax: 300, category: 'Extremadamente Mala', risk_level: 'Extremadamente Alto', color_name: 'Púrpura' },
        { min: 251, max: 350, iasMin: 301, iasMax: 500, category: 'Peligrosa', risk_level: 'Peligroso', color_name: 'Marrón' }
      ]
    };
    
    // Calculate IAS for each valid parameter
    const validParameters = [];
    
    // Check Ozone
    if (parameters.o3 !== undefined && parameters.o3 !== null) {
      const ozoneValue = parseFloat(parameters.o3);
      const ozoneIAS = calculateIASForParameter(ozoneValue, 'o3', iasBreakpoints.o3);
      if (ozoneIAS) {
        validParameters.push({
          pollutant: 'o3',
          value: ozoneValue,
          iasValue: ozoneIAS.iasValue,
          category: ozoneIAS.category,
          risk_level: ozoneIAS.risk_level,
          color_name: ozoneIAS.color_name
        });
      }
    }
    
    // Check CO
    if (parameters.co !== undefined && parameters.co !== null) {
      const coValue = parseFloat(parameters.co);
      const coIAS = calculateIASForParameter(coValue, 'co', iasBreakpoints.co);
      if (coIAS) {
        validParameters.push({
          pollutant: 'co',
          value: coValue,
          iasValue: coIAS.iasValue,
          category: coIAS.category,
          risk_level: coIAS.risk_level,
          color_name: coIAS.color_name
        });
      }
    }
    
    // Check NO2
    if (parameters.no2 !== undefined && parameters.no2 !== null) {
      const no2Value = parseFloat(parameters.no2);
      const no2IAS = calculateIASForParameter(no2Value, 'no2', iasBreakpoints.no2);
      if (no2IAS) {
        validParameters.push({
          pollutant: 'no2',
          value: no2Value,
          iasValue: no2IAS.iasValue,
          category: no2IAS.category,
          risk_level: no2IAS.risk_level,
          color_name: no2IAS.color_name
        });
      }
    }
    
    // Check SO2
    if (parameters.so2 !== undefined && parameters.so2 !== null) {
      const so2Value = parseFloat(parameters.so2);
      const so2IAS = calculateIASForParameter(so2Value, 'so2', iasBreakpoints.so2);
      if (so2IAS) {
        validParameters.push({
          pollutant: 'so2',
          value: so2Value,
          iasValue: so2IAS.iasValue,
          category: so2IAS.category,
          risk_level: so2IAS.risk_level,
          color_name: so2IAS.color_name
        });
      }
    }
    
    // If we have valid parameters, find the one with the highest IAS value
    if (validParameters.length > 0) {
      // Sort by IAS value, highest first
      validParameters.sort((a, b) => b.iasValue - a.iasValue);
      
      // Return the highest IAS value
      return validParameters[0];
    }
    
    // If no valid parameters, return null
    console.log(`No valid parameters found for IAS calculation for station ${stationId}`);
    return null;
  } catch (error) {
    console.error(`Error in recalculateIASWithValidParameters for station ${stationId}:`, error);
    return null;
  }
}

/**
 * Calculate IAS value for a specific pollutant
 * 
 * @param {Number} value - Pollutant value
 * @param {String} pollutant - Pollutant ID
 * @param {Array} breakpoints - IAS breakpoints for this pollutant
 * @returns {Object|null} IAS calculation result or null if not possible
 */
function calculateIASForParameter(value, pollutant, breakpoints) {
  try {
    // Find the appropriate breakpoint range
    for (const range of breakpoints) {
      if (value >= range.min && value <= range.max) {
        // Linear interpolation
        const iasValue = Math.round(
          range.iasMin + 
          ((value - range.min) * (range.iasMax - range.iasMin)) / 
          (range.max - range.min)
        );
        
        return {
          iasValue,
          category: range.category,
          risk_level: range.risk_level,
          color_name: range.color_name
        };
      }
    }
    
    // If value is greater than the maximum defined range
    if (value > breakpoints[breakpoints.length-1].max) {
      return {
        iasValue: breakpoints[breakpoints.length-1].iasMax,
        category: breakpoints[breakpoints.length-1].category,
        risk_level: breakpoints[breakpoints.length-1].risk_level,
        color_name: breakpoints[breakpoints.length-1].color_name
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Error calculating IAS for ${pollutant} with value ${value}:`, error);
    return null;
  }
}

/**
 * Get the weighted field name for a parameter
 * 
 * @param {String} parameter - Parameter ID
 * @returns {String} Database field name for the weighted value
 */
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

// Direct pipeline for ozone processing
async function processOzoneDirectPipeline(connection, date, hour) {
  try {
    console.log(`Running direct ozone pipeline for ${date}, hour ${hour}`);
    
    // Calculate ozone hourly average directly from raw readings
    const [ozoneRawAvg] = await connection.execute(`
      SELECT 
        station_id,
        reading_date,
        reading_hour,
        AVG(value) as avg_value,
        COUNT(*) as sample_count
      FROM 
        readings
      WHERE 
        parameter_id = 'o3'
        AND device_source = 'smability'
        AND reading_date = ?
        AND reading_hour = ?
        AND value IS NOT NULL
      GROUP BY 
        station_id, reading_date, reading_hour
      HAVING COUNT(*) >= 3  -- Only need 3 readings per hour to calculate average
    `, [date, hour]);
    
    console.log(`Found ${ozoneRawAvg.length} stations with sufficient ozone data`);
    
    // Update air_quality_index table
    let updatedCount = 0;
    
    for (const station of ozoneRawAvg) {
      if (station.avg_value) {
        const formattedValue = parseFloat(station.avg_value).toFixed(3);
        
        const [updateResult] = await connection.execute(`
          UPDATE air_quality_index
          SET 
            o3_value = ?,
            last_updated = CURRENT_TIMESTAMP
          WHERE 
            station_id = ?
            AND reading_date = ?
            AND reading_hour = ?
        `, [
          formattedValue, 
          station.station_id, 
          station.reading_date, 
          station.reading_hour
        ]);
        
        if (updateResult.affectedRows > 0) {
          updatedCount++;
          
          // After updating ozone, recalculate the IAS if necessary
          try {
            // Get station data with all pollutant values
            const [stationData] = await connection.execute(`
              SELECT 
                station_id, dominant_pollutant, o3_value, co_value, no2_value, 
                pm25_value, pm10_value, so2_value
              FROM air_quality_index 
              WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
            `, [station.station_id, station.reading_date, station.reading_hour]);
            
            if (stationData.length > 0) {
              // Create parameters object for IAS recalculation
              const pollutants = stationData[0];
              const parameters = {
                o3: pollutants.o3_value,
                co: pollutants.co_value,
                no2: pollutants.no2_value,
                pm25: pollutants.pm25_value,
                pm10: pollutants.pm10_value,
                so2: pollutants.so2_value
              };
              
              // Use the existing recalculate function from weight calculator
              const recalculatedIAS = await recalculateIASWithValidParameters(
                connection, 
                station.station_id, 
                station.reading_date, 
                station.reading_hour, 
                parameters, 
                {} // No validation failures
              );
              
              if (recalculatedIAS) {
                // Update air_quality_index with new IAS value
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
                  station.station_id, station.reading_date, station.reading_hour
                ]);
                
                console.log(`Recalculated IAS for ${station.station_id}: new value ${recalculatedIAS.iasValue}, new dominant pollutant ${recalculatedIAS.pollutant}`);
              }
            }
          } catch (iasError) {
            console.error(`Error recalculating IAS for station ${station.station_id}:`, iasError);
          }
        }
      }
    }
    
    console.log(`Direct ozone pipeline updated ${updatedCount} rows in air_quality_index`);
    
    // Check if we're in the first 5 minutes of the hour
    const now = new Date();
    const currentMinute = now.getMinutes();
    
    if (currentMinute < 5) {
      console.log("First 5 minutes of hour detected - using previous hour's ozone data for stations without current data");
      
      // Calculate previous hour information
      let prevHour = parseInt(hour) - 1;
      let prevDate = date;
      
      if (prevHour < 0) {
        prevHour = 23;
        // Calculate previous day
        const dateParts = date.split('-').map(part => parseInt(part));
        const prevDay = new Date(dateParts[0], dateParts[1] - 1, dateParts[2]);
        prevDay.setDate(prevDay.getDate() - 1);
        prevDate = `${prevDay.getFullYear()}-${String(prevDay.getMonth() + 1).padStart(2, '0')}-${String(prevDay.getDate()).padStart(2, '0')}`;
      }
      
      console.log(`Using previous hour data: ${prevDate}, hour ${prevHour}`);
      
      // Get all Smability stations with previous hour ozone data
      const [prevHourData] = await connection.execute(`
        SELECT a.station_id, a.o3_value, a.ias_numeric_value, a.dominant_pollutant
        FROM air_quality_index a
        JOIN stations s ON a.station_id = s.station_id
        WHERE a.reading_date = ? 
        AND a.reading_hour = ?
        AND a.o3_value IS NOT NULL
        AND s.monitor_type LIKE '%SMAA%'
      `, [prevDate, prevHour]);
      
      console.log(`Found ${prevHourData.length} stations with previous hour ozone data`);
      
      // Get all stations missing current hour ozone data
      const [missingStations] = await connection.execute(`
        SELECT a.station_id
        FROM air_quality_index a
        JOIN stations s ON a.station_id = s.station_id
        WHERE a.reading_date = ? 
        AND a.reading_hour = ?
        AND (a.o3_value IS NULL OR a.o3_value = 0)
        AND s.monitor_type LIKE '%SMAA%'
      `, [date, hour]);
      
      console.log(`Found ${missingStations.length} stations missing current hour ozone data`);
      
      // Create lookup for previous hour data for quick access
      const prevDataLookup = {};
      for (const row of prevHourData) {
        prevDataLookup[row.station_id] = row;
      }
      
      // Fill in missing stations with previous hour data
      let tempFillCount = 0;
      
      for (const station of missingStations) {
        const stationId = station.station_id;
        
        // Skip if no previous hour data available
        if (!prevDataLookup[stationId]) continue;
        
        const prevValue = prevDataLookup[stationId].o3_value;
        if (!prevValue) continue;
        
        // Update with previous hour's data as a temporary value
        await connection.execute(`
          UPDATE air_quality_index
          SET 
            o3_value = ?,
            ozone_temp_fill = 1,
            last_updated = CURRENT_TIMESTAMP
          WHERE 
            station_id = ?
            AND reading_date = ?
            AND reading_hour = ?
        `, [
          prevValue, 
          stationId, 
          date, 
          hour
        ]);
        
        tempFillCount++;
        
        // Recalculate IAS with this temporary ozone value
        try {
          // Get station data with all pollutant values
          const [stationData] = await connection.execute(`
            SELECT 
              station_id, dominant_pollutant, o3_value, co_value, no2_value, 
              pm25_value, pm10_value, so2_value
            FROM air_quality_index 
            WHERE station_id = ? AND reading_date = ? AND reading_hour = ?
          `, [stationId, date, hour]);
          
          if (stationData.length > 0) {
            // Create parameters object for IAS recalculation
            const pollutants = stationData[0];
            const parameters = {
              o3: pollutants.o3_value,
              co: pollutants.co_value,
              no2: pollutants.no2_value,
              pm25: pollutants.pm25_value,
              pm10: pollutants.pm10_value,
              so2: pollutants.so2_value
            };
            
            // Use the existing recalculate function from weight calculator
            const recalculatedIAS = await recalculateIASWithValidParameters(
              connection, 
              stationId, 
              date, 
              hour, 
              parameters, 
              {} // No validation failures
            );
            
            if (recalculatedIAS) {
              // Update air_quality_index with new IAS value
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
              
              console.log(`Recalculated IAS (using temp ozone) for ${stationId}: new value ${recalculatedIAS.iasValue}, dominant pollutant ${recalculatedIAS.pollutant}`);
            }
          }
        } catch (tempIasError) {
          console.error(`Error recalculating temp IAS for station ${stationId}:`, tempIasError);
        }
      }
      
      console.log(`Temporarily filled ${tempFillCount} stations with previous hour ozone data`);
    }
    
  } catch (error) {
    console.error("Error in direct ozone pipeline:", error);
  }
}

// Export the functions for use in the main Lambda
module.exports = {
  calculateHourlyAverages,
  calculateAndStoreWeightedValues,
  calculateParticleWeightedValue, // Export for testing purposes
  recalculateIASWithValidParameters,  // Export for testing purposes
  processOzoneDirectPipeline
};
