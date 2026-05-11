#!/usr/bin/env node

/**
 * DDI API Mock Server
 * 
 * Serves mock data for the DDI REST API.
 * Uses Prism for dynamic mock generation from OpenAPI spec,
 * with fallback to static JSON files for specific examples.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { convertToDDIXML, getRootElementName } = require('./ddi-xml-converter');

const app = express();
const PORT = process.env.PORT || 4010;
const MOCKS_DIR = path.join(__dirname, 'data');
const SPEC_PATH = path.join(__dirname, '..', 'ddi-rest.yaml');

app.use(cors());
app.use(express.json());

// Helper to load JSON file
function loadMock(fileName) {
  const filePath = path.join(MOCKS_DIR, fileName);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return null;
}

// Helper to find item by ID or URN
function findById(data, id) {
  if (!data || !Array.isArray(data)) return null;
  return data.find(item => 
    item.id === id || 
    item.urn === id ||
    item.urn === `urn:ddi:example.agency:${id}:1.0.0`
  );
}

// Helper to parse query values (supports repeated params and comma-separated values)
function parseMultiValue(value) {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap(v => String(v).split(','))
    .map(v => v.trim())
    .filter(Boolean);
}

// Helper to filter data by query parameters
function filterData(data, query, resourceType = null) {
  if (!data || !Array.isArray(data)) return data;
  
  let filtered = [...data];
  
  // Filter by URN
  if (query.urn) {
    const urns = parseMultiValue(query.urn);
    filtered = filtered.filter(item => urns.includes(item.urn));
  }
  
  // Filter by agencyID
  if (query.agencyID) {
    const agencyIDs = parseMultiValue(query.agencyID);
    filtered = filtered.filter(item => agencyIDs.includes(item.agencyID));
  }
  
  // Filter by resourceID (id)
  if (query.resourceID || query.id) {
    const ids = parseMultiValue(query.resourceID || query.id);
    filtered = filtered.filter(item => ids.includes(item.id));
  }
  
  // Filter by version
  if (query.version) {
    const versions = parseMultiValue(query.version);
    filtered = filtered.filter(item => versions.includes(item.version));
  }
  
  // Filter by variableID (for variables list)
  if (query.variableID) {
    const ids = parseMultiValue(query.variableID);
    filtered = filtered.filter(item => {
      const itemId = item.id || extractId({ id: item.id, urn: item.urn });
      return ids.some(id => itemId === id || itemId === extractId({ id, urn: id }));
    });
  }
  
  // Filter by conceptID (for concepts list)
  if (query.conceptID) {
    const ids = parseMultiValue(query.conceptID);
    filtered = filtered.filter(item => {
      const itemId = item.id || extractId({ id: item.id, urn: item.urn });
      return ids.some(id => itemId === id || itemId === extractId({ id, urn: id }));
    });
  }
  
  // Filter by conceptReference (for variables)
  if (query.conceptReference) {
    const refs = parseMultiValue(query.conceptReference);
    filtered = filtered.filter(item => {
      if (!item.conceptReference) return false;
      const itemRefId = extractId(item.conceptReference);
      return refs.some(ref => {
        const refId = extractId({ id: ref, urn: ref });
        return itemRefId === refId;
      });
    });
  }

  // Filter concepts by conceptSchemeID
  if (resourceType === 'concepts' && query.conceptSchemeID) {
    const schemeIds = parseMultiValue(query.conceptSchemeID).map(id => extractId({ id, urn: id }) || id);
    const schemes = loadMock('concept-schemes.json') || [];
    const allowedConceptIds = new Set();

    schemes
      .filter(scheme => schemeIds.includes(scheme.id) || schemeIds.includes(extractId(scheme)))
      .forEach(scheme => {
        (scheme.concepts || []).forEach(conceptRef => {
          const conceptId = extractId(conceptRef);
          if (conceptId) allowedConceptIds.add(conceptId);
        });
      });

    filtered = filtered.filter(item => allowedConceptIds.has(item.id));
  }

  // Filter variables by studyID (via study-unit -> dataset -> variable scheme)
  if (resourceType === 'variables' && query.studyID) {
    const studyIds = parseMultiValue(query.studyID).map(id => extractId({ id, urn: id }) || id);
    const studies = loadMock('study-units.json') || [];
    const datasets = loadMock('datasets.json') || [];
    const variableSchemeIds = new Set();
    const allowedVariableIds = new Set();

    const datasetIdsInStudy = new Set();
    studies
      .filter(study => studyIds.includes(study.id) || studyIds.includes(extractId(study)))
      .forEach(study => {
        (study.dataSetReference || []).forEach(datasetRef => {
          const datasetId = extractId(datasetRef);
          if (datasetId) datasetIdsInStudy.add(datasetId);
        });
      });

    datasets
      .filter(dataset => datasetIdsInStudy.has(dataset.id))
      .forEach(dataset => {
        const variableSchemeId = extractId(dataset.variableSchemeReference);
        if (variableSchemeId) variableSchemeIds.add(variableSchemeId);
      });

    const variableSchemes = loadMock('variable-schemes.json') || [];
    variableSchemes
      .filter(scheme => variableSchemeIds.has(scheme.id))
      .forEach(scheme => {
        (scheme.variables || []).forEach(variableRef => {
          const variableId = extractId(variableRef);
          if (variableId) allowedVariableIds.add(variableId);
        });
      });

    filtered = filtered.filter(item => allowedVariableIds.has(item.id));
  }

  // Filter variables by datasetID (via dataset -> variable scheme)
  if (resourceType === 'variables' && query.datasetID) {
    const datasetIds = parseMultiValue(query.datasetID).map(id => extractId({ id, urn: id }) || id);
    const datasets = loadMock('datasets.json') || [];
    const variableSchemeIds = new Set();
    const allowedVariableIds = new Set();

    datasets
      .filter(dataset => datasetIds.includes(dataset.id) || datasetIds.includes(extractId(dataset)))
      .forEach(dataset => {
        const variableSchemeId = extractId(dataset.variableSchemeReference);
        if (variableSchemeId) variableSchemeIds.add(variableSchemeId);
      });

    const variableSchemes = loadMock('variable-schemes.json') || [];
    variableSchemes
      .filter(scheme => variableSchemeIds.has(scheme.id))
      .forEach(scheme => {
        (scheme.variables || []).forEach(variableRef => {
          const variableId = extractId(variableRef);
          if (variableId) allowedVariableIds.add(variableId);
        });
      });

    filtered = filtered.filter(item => allowedVariableIds.has(item.id));
  }

  // Filter code lists by codeListSchemeID
  if (resourceType === 'code-lists' && query.codeListSchemeID) {
    const schemeIds = parseMultiValue(query.codeListSchemeID).map(id => extractId({ id, urn: id }) || id);
    const schemes = loadMock('code-list-schemes.json') || [];
    const allowedCodeListIds = new Set();

    schemes
      .filter(scheme => schemeIds.includes(scheme.id) || schemeIds.includes(extractId(scheme)))
      .forEach(scheme => {
        (scheme.codeLists || []).forEach(codeListRef => {
          const codeListId = extractId(codeListRef);
          if (codeListId) allowedCodeListIds.add(codeListId);
        });
      });

    filtered = filtered.filter(item => allowedCodeListIds.has(item.id));
  }

  // Filter code lists by categorySchemeReference (categories referenced by codes)
  if (resourceType === 'code-lists' && query.categorySchemeReference) {
    const schemeIds = parseMultiValue(query.categorySchemeReference).map(id => extractId({ id, urn: id }) || id);
    const categorySchemes = loadMock('category-schemes.json') || [];
    const allowedCategoryIds = new Set();

    categorySchemes
      .filter(scheme => schemeIds.includes(scheme.id) || schemeIds.includes(extractId(scheme)))
      .forEach(scheme => {
        (scheme.categories || []).forEach(categoryRef => {
          const categoryId = extractId(categoryRef);
          if (categoryId) allowedCategoryIds.add(categoryId);
        });
      });

    filtered = filtered.filter(codeList => {
      const codes = codeList.codes || [];
      return codes.some(code => {
        const categoryId = extractId(code.categoryReference);
        return categoryId && allowedCategoryIds.has(categoryId);
      });
    });
  }

  // Filter physical instances by datasetID
  if (resourceType === 'physical-instances' && query.datasetID) {
    const datasetIds = parseMultiValue(query.datasetID).map(id => extractId({ id, urn: id }) || id);
    filtered = filtered.filter(item => {
      const refId = extractId(item.dataSetReference);
      return refId && datasetIds.includes(refId);
    });
  }

  // Filter datasets by physicalInstanceID
  if (resourceType === 'datasets' && query.physicalInstanceID) {
    const physicalIds = parseMultiValue(query.physicalInstanceID).map(id => extractId({ id, urn: id }) || id);
    filtered = filtered.filter(item => {
      const refId = extractId(item.physicalInstanceReference);
      return refId && physicalIds.includes(refId);
    });
  }

  // Filter datasets by studyID
  if (resourceType === 'datasets' && query.studyID) {
    const studyIds = parseMultiValue(query.studyID).map(id => extractId({ id, urn: id }) || id);
    const studies = loadMock('study-units.json') || [];
    const allowedDatasetIds = new Set();

    studies
      .filter(study => studyIds.includes(study.id) || studyIds.includes(extractId(study)))
      .forEach(study => {
        (study.dataSetReference || []).forEach(datasetRef => {
          const datasetId = extractId(datasetRef);
          if (datasetId) allowedDatasetIds.add(datasetId);
        });
      });

    filtered = filtered.filter(item => allowedDatasetIds.has(item.id));
  }
  
  // Pagination
  const offset = parseInt(query.offset) || 0;
  const limit = query.limit ? parseInt(query.limit) : undefined;
  
  if (limit !== undefined) {
    filtered = filtered.slice(offset, offset + limit);
  } else if (offset > 0) {
    filtered = filtered.slice(offset);
  }
  
  return filtered;
}

// Helper to extract ID from URN or use direct ID
function extractId(ref) {
  if (!ref) return null;
  if (ref.id) return ref.id;
  if (ref.urn) {
    // URN format: urn:ddi:example.agency:concept-001:1.0.0
    // Extract the ID part (4th segment)
    const parts = ref.urn.split(':');
    if (parts.length >= 4) {
      return parts[3];
    }
  }
  return null;
}

// Helper to get the mock data file for a given type
function getMockDataForType(typeOfObject) {
  const typeMap = {
    'Concept': 'concepts.json',
    'Variable': 'variables.json',
    'ConceptScheme': 'concept-schemes.json',
    'VariableScheme': 'variable-schemes.json',
    'CodeList': 'code-lists.json',
    'CodeListScheme': 'code-list-schemes.json',
    'CategoryScheme': 'category-schemes.json',
    'Category': 'categories.json',
    'StudyUnit': 'study-units.json',
    'PhysicalInstance': 'physical-instances.json',
    'DataSet': 'datasets.json'
  };
  return typeMap[typeOfObject] || null;
}

// Helper to get the type for a scheme's children array
function getTypeForSchemeChildren(propertyName) {
  const typeMap = {
    'concepts': 'Concept',
    'variables': 'Variable',
    'codeLists': 'CodeList',
    'categories': 'Category',
    'dataSets': 'DataSet'
  };
  return typeMap[propertyName] || null;
}

// Helper to check if an object looks like an identifier (has urn/id/agencyID/version but no typeOfObject)
function isIdentifier(obj) {
  if (!obj || typeof obj !== 'object') return false;
  return (obj.urn || obj.id) && !obj.typeOfObject && !obj.type;
}

// Helper to get the property name for a resolved reference
// e.g., "conceptReference" -> "concept", "codeListReference" -> "codeList"
// Special case: "subclassOfReference" -> "subclassOf"
function getResolvedPropertyName(refPropertyName) {
  // Special cases
  if (refPropertyName === 'subclassOfReference') {
    return 'subclassOf';
  }
  
  // Handle SchemeReference first (check if it contains SchemeReference before Reference)
  // e.g., "conceptSchemeReference" -> "conceptScheme"
  // e.g., "categorySchemeReference" -> "categoryScheme"
  if (refPropertyName.includes('SchemeReference')) {
    return refPropertyName.replace('SchemeReference', 'Scheme');
  }
  
  // Handle regular Reference suffix
  // e.g., "conceptReference" -> "concept"
  if (refPropertyName.endsWith('Reference')) {
    return refPropertyName.slice(0, -9); // Remove "Reference" suffix
  }
  
  return refPropertyName;
}

// Helper to resolve a single reference
function resolveSingleReference(ref, level, isRecursive, currentDepth = 0, visited = new Set()) {
  if (!ref || typeof ref !== 'object') return ref;
  
  const refId = extractId(ref);
  if (!refId) return ref;
  
  const typeOfObject = ref.typeOfObject || ref.type;
  if (!typeOfObject) return ref;
  
  const mockFile = getMockDataForType(typeOfObject);
  if (!mockFile) return ref;
  
  const data = loadMock(mockFile);
  const resolvedObj = findById(data, refId);
  
  if (resolvedObj) {
    // If recursive, resolve all references in the resolved object
    // Pass currentDepth + 1 to continue recursive resolution
    // Also pass the visited set to prevent infinite loops
    return isRecursive ? resolveReferences(resolvedObj, level, currentDepth + 1, visited) : resolvedObj;
  }
  
  return ref;
}

// Helper to resolve references in an object (truly recursive and generic)
// level: 'none' (default), 'children' (first level only), 'all' (recursive)
// startDepth: starting depth for recursive processing (used internally)
// visited: Set of already visited URNs to prevent circular reference infinite loops
function resolveReferences(obj, level, startDepth = 0, visited = new Set()) {
  if (!level || level === 'none' || !obj || typeof obj !== 'object') return obj;
  
  // Prevent infinite recursion by tracking visited URNs
  const objUrn = obj.urn;
  if (objUrn && visited.has(objUrn)) {
    // Already visited this object - return reference instead of full object
    return {
      urn: obj.urn,
      id: obj.id,
      agencyID: obj.agencyID,
      version: obj.version,
      typeOfObject: obj.typeOfObject,
      _circularRef: true
    };
  }
  
  // Add current URN to visited set (only for recursive 'all' level)
  if (level === 'all' && objUrn) {
    visited = new Set(visited);
    visited.add(objUrn);
  }
  
  const resolved = JSON.parse(JSON.stringify(obj)); // Deep clone
  const isRecursive = level === 'all';
  
  // Helper to check if a property is a reference
  function isReferenceProperty(key, value) {
    if (!value || typeof value !== 'object') return false;
    // Check if it looks like a reference (has typeOfObject or type, or ends with Reference)
    // Skip SchemeReference properties as children don't reference their schemes
    if (key.endsWith('SchemeReference')) return false;
    return (value.typeOfObject || value.type || key.endsWith('Reference'));
  }
  
  // Recursively process object properties
  function processObject(objToProcess, depth = 0, visitedSet = visited) {
    if (!objToProcess || typeof objToProcess !== 'object') return objToProcess;
    
    // Special handling for arrays
    if (Array.isArray(objToProcess)) {
      return objToProcess.map(item => processObject(item, depth, visitedSet));
    }
    
    const processed = {};
    
    for (const [key, value] of Object.entries(objToProcess)) {
      // Skip certain properties that shouldn't be processed
      if (key === 'urn' || key === 'id' || key === 'agencyID' || key === 'version' || key === 'typeOfObject' || key === 'type') {
        processed[key] = value;
        continue;
      }
      
      // Handle reference properties
      if (isReferenceProperty(key, value)) {
        // For 'children' level: resolve only at depth 0
        // For 'all' level: resolve at all depths (truly recursive)
        if (depth === 0 || isRecursive) {
          const resolved = resolveSingleReference(value, level, isRecursive, depth, visited);
          // Replace xxxReference with xxx when resolved
          const resolvedKey = getResolvedPropertyName(key);
          processed[resolvedKey] = resolved;
          // Don't include the original Reference property when resolved
        } else {
          processed[key] = value; // Keep as reference for 'children' level at depth > 0
        }
      }
      // Special handling for nested paths (e.g., representation.codeRepresentation.codeListReference)
      else if (key === 'representation' && value?.codeRepresentation?.codeListReference) {
        const codeListRef = value.codeRepresentation.codeListReference;
        if (depth === 0 || isRecursive) {
          const resolved = resolveSingleReference(codeListRef, level, isRecursive, depth, visited);
          // Create a new codeRepresentation object without codeListReference
          const { codeListReference, ...codeRepresentationWithoutRef } = value.codeRepresentation;
          processed[key] = {
            ...value,
            codeRepresentation: {
              ...codeRepresentationWithoutRef,
              codeList: resolved // Replace codeListReference with codeList
            }
          };
        } else {
          processed[key] = {
            ...value,
            codeRepresentation: {
              ...value.codeRepresentation,
              codeListReference: codeListRef
            }
          };
        }
      }
      // Handle arrays that might contain references (e.g., codes in codeList)
      else if (Array.isArray(value)) {
        // Special handling for codes in codeList
        if (key === 'codes' && depth === 0) {
          // For codes, resolve categoryReference at children level
          processed[key] = value.map(code => {
            if (code.categoryReference) {
              const categoryId = extractId(code.categoryReference);
              if (categoryId) {
                const categories = loadMock('categories.json');
                const category = findById(categories, categoryId);
                if (category) {
                  const resolvedCategory = isRecursive ? resolveReferences(category, level, depth + 1, visited) : category;
                  // Exclude categoryReference when resolving to category
                  const { categoryReference, ...codeWithoutRef } = code;
                  return {
                    ...codeWithoutRef,
                    category: resolvedCategory // Replace categoryReference with category
                  };
                }
              }
            }
            return isRecursive ? processObject(code, depth + 1, visited) : code;
          });
        }
        // Special handling for scheme children (concepts, variables, codeLists, categories)
        // These are arrays of identifiers that should be resolved when references != 'none'
        else if (getTypeForSchemeChildren(key)) {
          const childType = getTypeForSchemeChildren(key);
          const mockFile = getMockDataForType(childType);
          if (mockFile) {
            const allChildren = loadMock(mockFile);
            processed[key] = value.map(identifier => {
              if (isIdentifier(identifier)) {
                const childId = identifier.id || extractId(identifier);
                if (childId) {
                  const child = findById(allChildren, childId);
                  if (child) {
                    // Resolve the child object
                    // For 'children' level: resolve object but not its internal references
                    // For 'all' level: resolve recursively with all references
                    if (isRecursive) {
                      return resolveReferences(child, level, depth + 1, visited);
                    } else {
                      // For 'children' level, return the full object but don't resolve its internal references
                      return child;
                    }
                  }
                }
              }
              // If not an identifier or not found, process as normal
              return processObject(identifier, depth + 1, visited);
            });
          } else {
            processed[key] = value.map(item => processObject(item, depth + 1, visited));
          }
        } else {
          processed[key] = value.map(item => processObject(item, depth + 1, visited));
        }
      }
      // Recursively process nested objects
      else if (value && typeof value === 'object') {
        processed[key] = processObject(value, depth + 1, visited);
      }
      // Keep primitive values as-is
      else {
        processed[key] = value;
      }
    }
    
    return processed;
  }
  
  return processObject(resolved, startDepth);
}

// Helper to determine response format based on Accept header
function getResponseFormat(req) {
  const accept = req.headers.accept || '';
  
  // If no Accept header or empty, default to DDI JSON
  if (!accept || accept.trim() === '') {
    return 'json';
  }
  
  // Check for DDI-specific formats first (explicit requests)
  if (accept.includes('application/vnd.ddi.structure+xml;version=3.3')) {
    return 'xml';
  }
  if (accept.includes('application/vnd.ddi.structure+json;version=3.3')) {
    return 'json';
  }
  
  // If Accept contains */* (wildcard), default to DDI JSON
  // This handles browser requests like "text/html,application/xhtml+xml,*/*;q=0.8"
  if (accept.includes('*/*')) {
    return 'json';
  }
  
  // If Accept is exactly */*, default to DDI JSON
  if (accept.trim() === '*/*') {
    return 'json';
  }
  
  // Unsupported/non-DDI Accept header
  return null;
}

// Helper to send response in appropriate format
function sendResponse(req, res, data, rootElementName) {
  const format = getResponseFormat(req);
  
  if (format === null) {
    // Unsupported format - return 406 Not Acceptable
    res.status(406).json({
      error: 'Not Acceptable',
      message: 'Only application/vnd.ddi.structure+json;version=3.3 and application/vnd.ddi.structure+xml;version=3.3 are supported',
      supportedFormats: [
        'application/vnd.ddi.structure+json;version=3.3',
        'application/vnd.ddi.structure+xml;version=3.3'
      ]
    });
    return;
  }
  
  if (format === 'xml') {
    res.set('Content-Type', 'application/vnd.ddi.structure+xml;version=3.3');
    try {
      // Use DDI XML converter instead of generic XML parser
      const xml = convertToDDIXML(data, rootElementName || getRootElementName(data));
      res.send(xml);
    } catch (error) {
      console.error('DDI XML conversion error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to convert response to DDI XML format'
      });
    }
  } else {
    // Set DDI JSON Content-Type
    res.set('Content-Type', 'application/vnd.ddi.structure+json;version=3.3');
    res.json(data);
  }
}

// Variables endpoints
app.get('/ddi/v1/variables', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('variables.json');
  
  // Apply filters
  data = filterData(data, req.query, 'variables');
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'variables');
  } else {
    sendResponse(req, res, data || [], 'variables');
  }
});

app.get('/ddi/v1/variables/:variableID', (req, res) => {
  const { variableID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('variables.json');
  const variable = findById(data, variableID);
  if (variable) {
    const resolved = resolveReferences(variable, references);
    sendResponse(req, res, resolved, 'variable');
  } else {
    res.status(404).json({ error: 'Variable not found' });
  }
});

// Concepts endpoints
app.get('/ddi/v1/concepts', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('concepts.json');
  
  // Apply filters
  data = filterData(data, req.query, 'concepts');
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'concepts');
  } else {
    sendResponse(req, res, data || [], 'concepts');
  }
});

app.get('/ddi/v1/concepts/:conceptID', (req, res) => {
  const { conceptID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('concepts.json');
  const concept = findById(data, conceptID);
  if (concept) {
    const resolved = resolveReferences(concept, references);
    sendResponse(req, res, resolved, 'concept');
  } else {
    res.status(404).json({ error: 'Concept not found' });
  }
});

// Concept Schemes endpoints
app.get('/ddi/v1/concept-schemes', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('concept-schemes.json');
  
  // Apply filters
  data = filterData(data, req.query);
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'conceptSchemes');
  } else {
    sendResponse(req, res, data || [], 'conceptSchemes');
  }
});

app.get('/ddi/v1/concept-schemes/:conceptSchemeID', (req, res) => {
  const { conceptSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('concept-schemes.json');
  const scheme = findById(data, conceptSchemeID);
  if (scheme) {
    const resolved = resolveReferences(scheme, references);
    sendResponse(req, res, resolved, 'conceptScheme');
  } else {
    res.status(404).json({ error: 'Concept scheme not found' });
  }
});

// Variable Schemes endpoints
app.get('/ddi/v1/variable-schemes', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('variable-schemes.json');
  
  // Apply filters
  data = filterData(data, req.query);
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'variableSchemes');
  } else {
    sendResponse(req, res, data || [], 'variableSchemes');
  }
});

app.get('/ddi/v1/variable-schemes/:variableSchemeID', (req, res) => {
  const { variableSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('variable-schemes.json');
  const scheme = findById(data, variableSchemeID);
  if (scheme) {
    const resolved = resolveReferences(scheme, references);
    sendResponse(req, res, resolved, 'variableScheme');
  } else {
    res.status(404).json({ error: 'Variable scheme not found' });
  }
});

// Code Lists endpoints
app.get('/ddi/v1/code-lists', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('code-lists.json');
  
  // Apply filters
  data = filterData(data, req.query, 'code-lists');
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'codeLists');
  } else {
    sendResponse(req, res, data || [], 'codeLists');
  }
});

app.get('/ddi/v1/code-lists/:codeListID', (req, res) => {
  const { codeListID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('code-lists.json');
  const codeList = findById(data, codeListID);
  if (codeList) {
    const resolved = resolveReferences(codeList, references);
    sendResponse(req, res, resolved, 'codeList');
  } else {
    res.status(404).json({ error: 'Code list not found' });
  }
});

// Code List Schemes endpoints
app.get('/ddi/v1/code-list-schemes', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('code-list-schemes.json');
  
  // Apply filters
  data = filterData(data, req.query);
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'codeListSchemes');
  } else {
    sendResponse(req, res, data || [], 'codeListSchemes');
  }
});

app.get('/ddi/v1/code-list-schemes/:codeListSchemeID', (req, res) => {
  const { codeListSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('code-list-schemes.json');
  const scheme = findById(data, codeListSchemeID);
  if (scheme) {
    const resolved = resolveReferences(scheme, references);
    sendResponse(req, res, resolved, 'codeListScheme');
  } else {
    res.status(404).json({ error: 'Code list scheme not found' });
  }
});

// Category Schemes endpoints
app.get('/ddi/v1/category-schemes', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('category-schemes.json');
  
  // Apply filters
  data = filterData(data, req.query);
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'categorySchemes');
  } else {
    sendResponse(req, res, data || [], 'categorySchemes');
  }
});

app.get('/ddi/v1/category-schemes/:categorySchemeID', (req, res) => {
  const { categorySchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('category-schemes.json');
  const scheme = findById(data, categorySchemeID);
  if (scheme) {
    const resolved = resolveReferences(scheme, references);
    sendResponse(req, res, resolved, 'categoryScheme');
  } else {
    res.status(404).json({ error: 'Category scheme not found' });
  }
});

// Study Units endpoints
app.get('/ddi/v1/study-units', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('study-units.json');
  
  // Apply filters
  data = filterData(data, req.query);
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'studyUnits');
  } else {
    sendResponse(req, res, data || [], 'studyUnits');
  }
});

app.get('/ddi/v1/study-units/:studyUnitID', (req, res) => {
  const { studyUnitID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('study-units.json');
  const studyUnit = findById(data, studyUnitID);
  if (studyUnit) {
    const resolved = resolveReferences(studyUnit, references);
    sendResponse(req, res, resolved, 'studyUnit');
  } else {
    res.status(404).json({ error: 'Study unit not found' });
  }
});

// Physical Instances endpoints
app.get('/ddi/v1/physical-instances', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('physical-instances.json');
  
  // Apply filters
  data = filterData(data, req.query, 'physical-instances');
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'physicalInstances');
  } else {
    sendResponse(req, res, data || [], 'physicalInstances');
  }
});

app.get('/ddi/v1/physical-instances/:physicalInstanceID', (req, res) => {
  const { physicalInstanceID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('physical-instances.json');
  const physicalInstance = findById(data, physicalInstanceID);
  if (physicalInstance) {
    const resolved = resolveReferences(physicalInstance, references);
    sendResponse(req, res, resolved, 'physicalInstance');
  } else {
    res.status(404).json({ error: 'Physical instance not found' });
  }
});

// Datasets endpoints
app.get('/ddi/v1/datasets', (req, res) => {
  const references = req.query.references || 'none';
  let data = loadMock('datasets.json');
  
  // Apply filters
  data = filterData(data, req.query, 'datasets');
  
  // Resolve references if requested
  if (data && references !== 'none') {
    const resolved = data.map(item => resolveReferences(item, references));
    sendResponse(req, res, resolved, 'dataSets');
  } else {
    sendResponse(req, res, data || [], 'dataSets');
  }
});

app.get('/ddi/v1/datasets/:datasetID', (req, res) => {
  const { datasetID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('datasets.json');
  const dataset = findById(data, datasetID);
  if (dataset) {
    const resolved = resolveReferences(dataset, references);
    sendResponse(req, res, resolved, 'dataSet');
  } else {
    res.status(404).json({ error: 'Dataset not found' });
  }
});

// Search endpoint - Search by labels
app.get('/ddi/v1/search/labels', (req, res) => {
  const query = req.query.q;
  const lang = req.query.lang || 'en';
  const types = req.query.type ? (Array.isArray(req.query.type) ? req.query.type : [req.query.type]) : null;
  const offset = parseInt(req.query.offset) || 0;
  const limit = parseInt(req.query.limit) || 100;

  if (!query || query.trim().length === 0) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  if (lang !== 'en' && lang !== 'fr') {
    return res.status(400).json({ error: 'Language parameter "lang" must be "en" or "fr"' });
  }

  const searchQuery = query.toLowerCase().trim();
  const results = [];

  // Helper function to search labels in a resource
  function searchInResource(resource, resourceType) {
    if (!resource || !resource.label || !Array.isArray(resource.label)) {
      return null;
    }

    // Find matching label in the specified language
    const matchingLabel = resource.label.find(l => l.lang === lang && 
      l.value && l.value.toLowerCase().includes(searchQuery));

    if (matchingLabel) {
      return {
        type: resourceType,
        urn: resource.urn,
        id: resource.id,
        agencyID: resource.agencyID,
        version: resource.version,
        label: resource.label,
        matchedLabel: matchingLabel
      };
    }
    return null;
  }

  // Search in variables
  if (!types || types.includes('Variable')) {
    const variables = loadMock('variables.json') || [];
    variables.forEach(variable => {
      const result = searchInResource(variable, 'Variable');
      if (result) results.push(result);
    });
  }

  // Search in concepts
  if (!types || types.includes('Concept')) {
    const concepts = loadMock('concepts.json') || [];
    concepts.forEach(concept => {
      const result = searchInResource(concept, 'Concept');
      if (result) results.push(result);
    });
  }

  // Search in concept schemes
  if (!types || types.includes('ConceptScheme')) {
    const conceptSchemes = loadMock('concept-schemes.json') || [];
    conceptSchemes.forEach(scheme => {
      const result = searchInResource(scheme, 'ConceptScheme');
      if (result) results.push(result);
    });
  }

  // Search in variable schemes
  if (!types || types.includes('VariableScheme')) {
    const variableSchemes = loadMock('variable-schemes.json') || [];
    variableSchemes.forEach(scheme => {
      const result = searchInResource(scheme, 'VariableScheme');
      if (result) results.push(result);
    });
  }

  // Search in code lists
  if (!types || types.includes('CodeList')) {
    const codeLists = loadMock('code-lists.json') || [];
    codeLists.forEach(codeList => {
      const result = searchInResource(codeList, 'CodeList');
      if (result) results.push(result);
    });
  }

  // Search in code list schemes
  if (!types || types.includes('CodeListScheme')) {
    const codeListSchemes = loadMock('code-list-schemes.json') || [];
    codeListSchemes.forEach(scheme => {
      const result = searchInResource(scheme, 'CodeListScheme');
      if (result) results.push(result);
    });
  }

  // Search in category schemes
  if (!types || types.includes('CategoryScheme')) {
    const categorySchemes = loadMock('category-schemes.json') || [];
    categorySchemes.forEach(scheme => {
      const result = searchInResource(scheme, 'CategoryScheme');
      if (result) results.push(result);
    });
  }

  // Search in categories
  if (!types || types.includes('Category')) {
    const categories = loadMock('categories.json') || [];
    categories.forEach(category => {
      const result = searchInResource(category, 'Category');
      if (result) results.push(result);
    });
  }

  // Apply pagination
  const paginatedResults = results.slice(offset, offset + limit);

  sendResponse(req, res, paginatedResults, 'searchResults');
});

// Health check endpoint (for Render and other services to prevent sleep)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'DDI API Mock Server',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint (also for health checks)
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'DDI API Mock Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    endpoints: {
      health: '/health',
      variables: {
        list: '/ddi/v1/variables',
        item: '/ddi/v1/variables/{variableID}'
      },
      concepts: {
        list: '/ddi/v1/concepts',
        item: '/ddi/v1/concepts/{conceptID}'
      },
      conceptSchemes: {
        list: '/ddi/v1/concept-schemes',
        item: '/ddi/v1/concept-schemes/{conceptSchemeID}'
      },
      variableSchemes: {
        list: '/ddi/v1/variable-schemes',
        item: '/ddi/v1/variable-schemes/{variableSchemeID}'
      },
      codeLists: {
        list: '/ddi/v1/code-lists',
        item: '/ddi/v1/code-lists/{codeListID}'
      },
      codeListSchemes: {
        list: '/ddi/v1/code-list-schemes',
        item: '/ddi/v1/code-list-schemes/{codeListSchemeID}'
      },
      categorySchemes: {
        list: '/ddi/v1/category-schemes',
        item: '/ddi/v1/category-schemes/{categorySchemeID}'
      },
      studyUnits: {
        list: '/ddi/v1/study-units',
        item: '/ddi/v1/study-units/{studyUnitID}'
      },
      physicalInstances: {
        list: '/ddi/v1/physical-instances',
        item: '/ddi/v1/physical-instances/{physicalInstanceID}'
      },
      dataSets: {
        list: '/ddi/v1/datasets',
        item: '/ddi/v1/datasets/{datasetID}'
      }
    },
    documentation: {
      swaggerUI: 'https://making-sense-info.github.io/DDI-API/',
      endpoints: 'https://github.com/Making-Sense-Info/DDI-API/blob/main/docs/MOCK_API_ENDPOINTS.md'
    },
    queryParameters: {
      references: {
        description: 'Control how referenced objects are returned',
        values: ['none', 'children', 'all'],
        default: 'none'
      },
      filtering: {
        description: 'Filter resources by various criteria',
        supported: ['urn', 'agencyID', 'resourceID', 'version', 'offset', 'limit']
      }
    }
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 DDI API Mock Server running on http://127.0.0.1:${PORT}`);
  console.log(`📄 Serving mock data from: ${MOCKS_DIR}`);
  console.log(`📋 OpenAPI spec: ${SPEC_PATH}`);
});

