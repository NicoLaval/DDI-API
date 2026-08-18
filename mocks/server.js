#!/usr/bin/env node

/**
 * DDI API Mock Server
 *
 * Serves mock data from static JSON files under mocks/data/, aligned with ddi-rest.yaml.
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

app.use(cors({
  exposedHeaders: ['Content-Range', 'Link']
}));
app.set('trust proxy', 1);
app.use(express.json());

// Helper to load JSON file
function loadMock(fileName) {
  const filePath = path.join(MOCKS_DIR, fileName);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return null;
}

/** True if value is a DDI URN (namespace-specific string starts after urn:ddi:) */
function isDdiUrn(s) {
  if (!s || typeof s !== 'string') return false;
  return /^urn:ddi:/i.test(s.trim());
}

/**
 * Parse NSS of urn:ddi:<agency>:<resource>:<version>
 * Agency segment may contain dots; resource/version per RFC 9517 restricted strings (no extra colons in mock data).
 */
function parseDdiUrn(urn) {
  const parts = String(urn).trim().split(':');
  if (parts.length < 5) return null;
  if (parts[0].toLowerCase() !== 'urn' || parts[1].toLowerCase() !== 'ddi') return null;
  const agency = parts[2];
  const resource = parts[3];
  const version = parts.slice(4).join(':');
  return { agency, resource, version };
}

/** Lexical match for DDI URNs (agency compared case-insensitively per RFC 9517). */
function urnsEqual(a, b) {
  if (!a || !b) return false;
  const pa = parseDdiUrn(a);
  const pb = parseDdiUrn(b);
  if (pa && pb) {
    return (
      pa.agency.toLowerCase() === pb.agency.toLowerCase() &&
      pa.resource === pb.resource &&
      pa.version === pb.version
    );
  }
  return String(a) === String(b);
}

/** Query params whose values can be plain IDs requiring agencyID + version (see OpenAPI). */
const QUERY_PARAM_KEYS_WITH_RESOURCE_IDS = [
  'variableID',
  'conceptID',
  'resourceID',
  'id',
  'conceptReference',
  'studyID',
  'datasetID',
  'conceptSchemeID',
  'variableSchemeID',
  'codeListSchemeID',
  'codeListID',
  'categorySchemeID',
  'categorySchemeReference',
  'studyUnitID',
  'physicalInstanceID'
];

function validatePlainIdentifierParams(query) {
  let hasPlain = false;
  for (const key of QUERY_PARAM_KEYS_WITH_RESOURCE_IDS) {
    if (!query[key]) continue;
    for (const token of parseMultiValue(query[key])) {
      if (token && !isDdiUrn(token)) {
        hasPlain = true;
        break;
      }
    }
    if (hasPlain) break;
  }
  if (!hasPlain) return { ok: true };
  const agencies = parseMultiValue(query.agencyID);
  const versions = parseMultiValue(query.version);
  if (agencies.length === 0 || versions.length === 0) {
    return {
      ok: false,
      message:
        'Plain resource identifiers require agencyID and version query parameters.'
    };
  }
  return { ok: true };
}

/** Match a stored resource item against a path/query token (URN or scoped plain id). */
function matchesIdentifierToken(item, token, query) {
  if (!item || token === undefined || token === null) return false;
  const t = String(token).trim();
  if (!t) return false;
  if (isDdiUrn(t)) return urnsEqual(item.urn, t);
  const agencies = parseMultiValue(query.agencyID);
  const versions = parseMultiValue(query.version);
  if (agencies.length === 0 || versions.length === 0) return false;
  return (
    item.id === t &&
    String(item.agencyID).toLowerCase() === agencies[0].toLowerCase() &&
    item.version === versions[0]
  );
}

/** Match a DDI reference object against a token (URN or plain id + query agency/version). */
function referenceMatchesToken(ref, token, query) {
  if (!ref) return false;
  const t = String(token).trim();
  if (!t) return false;
  if (isDdiUrn(t)) return urnsEqual(ref.urn, t);
  const agencies = parseMultiValue(query.agencyID);
  const versions = parseMultiValue(query.version);
  if (agencies.length === 0 || versions.length === 0) return false;
  return (
    ref.id === t &&
    String(ref.agencyID).toLowerCase() === agencies[0].toLowerCase() &&
    ref.version === versions[0]
  );
}

/**
 * Resolve a single resource by path segment: URN anywhere, or plain id with agencyID + version query.
 * @returns {{ item: object|null, error: null|'badrequest'|'notfound', message?: string }}
 */
function findResourceForRequest(data, pathIdentifier, query) {
  if (!data || !Array.isArray(data)) return { item: null, error: 'notfound' };
  const pid = String(pathIdentifier || '').trim();
  if (!pid) return { item: null, error: 'notfound' };

  if (isDdiUrn(pid)) {
    const item = data.find(it => urnsEqual(it.urn, pid));
    return { item: item || null, error: item ? null : 'notfound' };
  }

  const agencies = parseMultiValue(query.agencyID);
  const versions = parseMultiValue(query.version);
  if (agencies.length === 0 || versions.length === 0) {
    return {
      item: null,
      error: 'badrequest',
      message:
        'Plain resource ID requires agencyID and version query parameters.'
    };
  }

  const item = data.find(
    it =>
      it.id === pid &&
      String(it.agencyID).toLowerCase() === agencies[0].toLowerCase() &&
      it.version === versions[0]
  );
  return { item: item || null, error: item ? null : 'notfound' };
}

// Helper to find item by ID or URN (internal resolution; mock ids are unique per file)
function findById(data, idOrUrn) {
  if (!data || !Array.isArray(data)) return null;
  const key = String(idOrUrn || '').trim();
  if (!key) return null;
  if (isDdiUrn(key)) {
    return data.find(item => urnsEqual(item.urn, key));
  }
  return data.find(item => item.id === key || urnsEqual(item.urn, key));
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

/**
 * Build aggregated ItemCatalog using the same filterData rules as each list endpoint.
 * @returns {{ ok: true, bundle: object } | { ok: false, status: number, message: string }}
 */
function buildItemCatalog(query) {
  const catalogDefs = [
    ['variables', 'variables.json', 'variables'],
    ['concepts', 'concepts.json', 'concepts'],
    ['conceptSchemes', 'concept-schemes.json', null],
    ['variableSchemes', 'variable-schemes.json', null],
    ['codeLists', 'code-lists.json', 'code-lists'],
    ['codeListSchemes', 'code-list-schemes.json', null],
    ['categorySchemes', 'category-schemes.json', null],
    ['categories', 'categories.json', null],
    ['studyUnits', 'study-units.json', null],
    ['physicalInstances', 'physical-instances.json', 'physical-instances'],
    ['dataSets', 'datasets.json', 'datasets']
  ];

  const bundle = {};
  for (const [key, file, resourceType] of catalogDefs) {
    const data = loadMock(file) || [];
    const fd = filterData(data, query, resourceType);
    if (!fd.ok) {
      return { ok: false, status: fd.status, message: fd.message };
    }
    bundle[key] = fd.data;
  }
  return { ok: true, bundle };
}

/** Order used to resolve polymorphic GET /items/{itemIdentifier} (first match wins). */
const ITEM_SINGLE_SEARCH_ORDER = [
  ['variables.json', 'variable'],
  ['concepts.json', 'concept'],
  ['concept-schemes.json', 'conceptScheme'],
  ['variable-schemes.json', 'variableScheme'],
  ['code-lists.json', 'codeList'],
  ['code-list-schemes.json', 'codeListScheme'],
  ['category-schemes.json', 'categoryScheme'],
  ['categories.json', 'category'],
  ['study-units.json', 'studyUnit'],
  ['physical-instances.json', 'physicalInstance'],
  ['datasets.json', 'dataSet']
];

/**
 * Parse `{agencyID}:{id}:{version}` from a single path segment (not a DDI URN).
 * Agency may contain dots; id and version must not contain ':'.
 */
function parseAgencyIdVersionTriple(segment) {
  if (!segment || typeof segment !== 'string') return null;
  const t = segment.trim();
  if (!t || isDdiUrn(t)) return null;
  const last = t.lastIndexOf(':');
  if (last <= 0) return null;
  const version = t.slice(last + 1);
  const rest = t.slice(0, last);
  const mid = rest.lastIndexOf(':');
  if (mid <= 0) return null;
  const id = rest.slice(mid + 1);
  const agencyID = rest.slice(0, mid);
  if (!agencyID || !id || !version) return null;
  if (id.includes(':') || version.includes(':')) return null;
  return { agencyID, id, version };
}

/**
 * Resolve one item across all collections (polymorphic item URL).
 * @returns {{ item: object, xmlRoot: string } | { error: 'notfound' } | { error: 'badrequest', message: string }}
 */
function findItemByPathSegment(itemIdentifier, query) {
  let decoded = String(itemIdentifier || '').trim();
  if (!decoded) return { error: 'notfound' };
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep raw
  }

  if (isDdiUrn(decoded)) {
    for (const [file, xmlRoot] of ITEM_SINGLE_SEARCH_ORDER) {
      const data = loadMock(file);
      if (!data || !Array.isArray(data)) continue;
      const item = data.find(it => urnsEqual(it.urn, decoded));
      if (item) return { item, xmlRoot };
    }
    return { error: 'notfound' };
  }

  const triple = parseAgencyIdVersionTriple(decoded);
  if (triple) {
    const { agencyID: a, id, version } = triple;
    for (const [file, xmlRoot] of ITEM_SINGLE_SEARCH_ORDER) {
      const data = loadMock(file);
      if (!data || !Array.isArray(data)) continue;
      const item = data.find(
        it =>
          it.id === id &&
          String(it.agencyID).toLowerCase() === String(a).toLowerCase() &&
          it.version === version
      );
      if (item) return { item, xmlRoot };
    }
    return { error: 'notfound' };
  }

  for (const [file, xmlRoot] of ITEM_SINGLE_SEARCH_ORDER) {
    const data = loadMock(file);
    if (!data || !Array.isArray(data)) continue;
    const fr = findResourceForRequest(data, decoded, query);
    if (fr.error === 'badrequest') {
      return { error: 'badrequest', message: fr.message };
    }
    if (fr.item) return { item: fr.item, xmlRoot };
  }
  return { error: 'notfound' };
}

/** Flatten grouped ItemCatalog into one array for DDI XML (fixed order). */
function flattenItemCatalogForXml(bundle) {
  const order = [
    'variables',
    'concepts',
    'conceptSchemes',
    'variableSchemes',
    'codeLists',
    'codeListSchemes',
    'categorySchemes',
    'categories',
    'studyUnits',
    'physicalInstances',
    'dataSets'
  ];
  const flat = [];
  for (const key of order) {
    (bundle[key] || []).forEach(item => flat.push(item));
  }
  return flat;
}

// Helper to filter data by query parameters
function filterData(data, query, resourceType = null) {
  const validation = validatePlainIdentifierParams(query);
  if (!validation.ok) {
    return {
      ok: false,
      status: 400,
      message: validation.message
    };
  }

  if (!data || !Array.isArray(data)) return { ok: true, data };

  let filtered = [...data];

  // Filter by URN
  if (query.urn) {
    const urns = parseMultiValue(query.urn);
    filtered = filtered.filter(item => urns.some(u => urnsEqual(item.urn, u)));
  }

  // Filter by agencyID
  if (query.agencyID) {
    const agencyIDs = parseMultiValue(query.agencyID);
    filtered = filtered.filter(item =>
      agencyIDs.some(a => String(item.agencyID).toLowerCase() === String(a).toLowerCase())
    );
  }

  // Filter by resourceID (id)
  if (query.resourceID || query.id) {
    const ids = parseMultiValue(query.resourceID || query.id);
    filtered = filtered.filter(item =>
      ids.some(token => matchesIdentifierToken(item, token, query))
    );
  }

  // Filter by version
  if (query.version) {
    const versions = parseMultiValue(query.version);
    filtered = filtered.filter(item => versions.includes(item.version));
  }

  // Filter by variableID (for variables list)
  if (query.variableID) {
    const ids = parseMultiValue(query.variableID);
    filtered = filtered.filter(item =>
      ids.some(token => matchesIdentifierToken(item, token, query))
    );
  }

  // Filter by conceptID (for concepts list)
  if (query.conceptID) {
    const ids = parseMultiValue(query.conceptID);
    filtered = filtered.filter(item =>
      ids.some(token => matchesIdentifierToken(item, token, query))
    );
  }

  // Filter by conceptReference (for variables)
  if (query.conceptReference) {
    const refs = parseMultiValue(query.conceptReference);
    filtered = filtered.filter(item =>
      refs.some(token => referenceMatchesToken(item.conceptReference, token, query))
    );
  }

  // Filter concepts by conceptSchemeID
  if (resourceType === 'concepts' && query.conceptSchemeID) {
    const schemeTokens = parseMultiValue(query.conceptSchemeID);
    const schemes = loadMock('concept-schemes.json') || [];
    const allowedConceptIds = new Set();

    schemes
      .filter(scheme =>
        schemeTokens.some(t => matchesIdentifierToken(scheme, t, query))
      )
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
    const studyTokens = parseMultiValue(query.studyID);
    const studies = loadMock('study-units.json') || [];
    const datasets = loadMock('datasets.json') || [];
    const variableSchemeIds = new Set();
    const allowedVariableIds = new Set();

    const datasetIdsInStudy = new Set();
    studies
      .filter(study =>
        studyTokens.some(t => matchesIdentifierToken(study, t, query))
      )
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
    const datasetTokens = parseMultiValue(query.datasetID);
    const datasets = loadMock('datasets.json') || [];
    const variableSchemeIds = new Set();
    const allowedVariableIds = new Set();

    datasets
      .filter(dataset =>
        datasetTokens.some(t => matchesIdentifierToken(dataset, t, query))
      )
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
    const schemeTokens = parseMultiValue(query.codeListSchemeID);
    const schemes = loadMock('code-list-schemes.json') || [];
    const allowedCodeListIds = new Set();

    schemes
      .filter(scheme =>
        schemeTokens.some(t => matchesIdentifierToken(scheme, t, query))
      )
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
    const schemeTokens = parseMultiValue(query.categorySchemeReference);
    const categorySchemes = loadMock('category-schemes.json') || [];
    const allowedCategoryIds = new Set();

    categorySchemes
      .filter(scheme =>
        schemeTokens.some(t => matchesIdentifierToken(scheme, t, query))
      )
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
    const datasetTokens = parseMultiValue(query.datasetID);
    filtered = filtered.filter(item =>
      datasetTokens.some(t =>
        referenceMatchesToken(item.dataSetReference, t, query)
      )
    );
  }

  // Filter datasets by physicalInstanceID
  if (resourceType === 'datasets' && query.physicalInstanceID) {
    const physicalTokens = parseMultiValue(query.physicalInstanceID);
    filtered = filtered.filter(item =>
      physicalTokens.some(t =>
        referenceMatchesToken(item.physicalInstanceReference, t, query)
      )
    );
  }

  // Filter datasets by studyID
  if (resourceType === 'datasets' && query.studyID) {
    const studyTokens = parseMultiValue(query.studyID);
    const studies = loadMock('study-units.json') || [];
    const allowedDatasetIds = new Set();

    studies
      .filter(study =>
        studyTokens.some(t => matchesIdentifierToken(study, t, query))
      )
      .forEach(study => {
        (study.dataSetReference || []).forEach(datasetRef => {
          const datasetId = extractId(datasetRef);
          if (datasetId) allowedDatasetIds.add(datasetId);
        });
      });

    filtered = filtered.filter(item => allowedDatasetIds.has(item.id));
  }

  return { ok: true, data: filtered };
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

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;

function firstQueryValue(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Parse offset/limit query params (always paginate lists). */
function parsePagination(query) {
  let offset = 0;
  let limit = DEFAULT_PAGE_LIMIT;

  if (query.offset !== undefined && query.offset !== '') {
    const raw = firstQueryValue(query.offset);
    if (!/^\d+$/.test(String(raw))) {
      return { ok: false, message: 'offset must be a non-negative integer.' };
    }
    offset = parseInt(raw, 10);
  }

  if (query.limit !== undefined && query.limit !== '') {
    const raw = firstQueryValue(query.limit);
    if (!/^\d+$/.test(String(raw))) {
      return { ok: false, message: 'limit must be a positive integer (maximum 1000).' };
    }
    limit = parseInt(raw, 10);
    if (limit < 1 || limit > MAX_PAGE_LIMIT) {
      return { ok: false, message: 'limit must be a positive integer (maximum 1000).' };
    }
  }

  return { ok: true, offset, limit };
}

function paginationQueryString(query, offset, limit) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (key === 'offset' || key === 'limit') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null || v === '') continue;
      params.append(key, String(v));
    }
  }
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  return params.toString();
}

function pageUrl(req, offset, limit) {
  return `${req.protocol}://${req.get('host')}${req.path}?${paginationQueryString(req.query, offset, limit)}`;
}

function setPaginationHeaders(req, res, { total, offset, limit }) {
  const hasItems = total > 0 && offset < total;
  if (!hasItems) {
    res.set('Content-Range', `items */${total}`);
  } else {
    const end = Math.min(offset + limit, total) - 1;
    res.set('Content-Range', `items ${offset}-${end}/${total}`);
  }

  const links = [];
  if (total > 0) {
    const lastOffset = Math.floor((total - 1) / limit) * limit;
    links.push(`<${pageUrl(req, 0, limit)}>; rel="first"`);
    links.push(`<${pageUrl(req, lastOffset, limit)}>; rel="last"`);
    if (offset > 0) {
      links.push(`<${pageUrl(req, Math.max(0, offset - limit), limit)}>; rel="prev"`);
    }
    if (offset + limit < total) {
      links.push(`<${pageUrl(req, offset + limit, limit)}>; rel="next"`);
    }
  }
  if (links.length > 0) {
    res.set('Link', links.join(', '));
  }
}

/** Filter, page, optionally resolve references, then send a collection GET. */
function serveCollection(req, res, data, resourceType, rootElementName) {
  const fd = filterData(data, req.query, resourceType);
  if (!fd.ok) {
    return res.status(fd.status).json({
      error: 'Bad Request',
      message: fd.message
    });
  }
  const pageSpec = parsePagination(req.query);
  if (!pageSpec.ok) {
    return res.status(400).json({
      error: 'Bad Request',
      message: pageSpec.message
    });
  }
  const references = req.query.references || 'none';
  let items = Array.isArray(fd.data) ? fd.data : [];
  const total = items.length;
  items = items.slice(pageSpec.offset, pageSpec.offset + pageSpec.limit);
  if (references !== 'none') {
    items = items.map(item => resolveReferences(item, references));
  }
  sendResponse(req, res, items, rootElementName, {
    total,
    offset: pageSpec.offset,
    limit: pageSpec.limit
  });
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
function sendResponse(req, res, data, rootElementName, pagination) {
  if (pagination) {
    setPaginationHeaders(req, res, pagination);
  }

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

// All items (aggregated collections) — register before parameterized routes
app.get('/ddi/v1/items', (req, res) => {
  const references = req.query.references || 'none';
  const built = buildItemCatalog(req.query);
  if (!built.ok) {
    return res.status(built.status).json({
      error: 'Bad Request',
      message: built.message
    });
  }
  let bundle = built.bundle;
  if (references !== 'none') {
    for (const key of Object.keys(bundle)) {
      bundle[key] = bundle[key].map(item => resolveReferences(item, references));
    }
  }

  const format = getResponseFormat(req);
  if (format === null) {
    res.status(406).json({
      error: 'Not Acceptable',
      message:
        'Only application/vnd.ddi.structure+json;version=3.3 and application/vnd.ddi.structure+xml;version=3.3 are supported',
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
      const flat = flattenItemCatalogForXml(bundle);
      const xml = convertToDDIXML(flat, 'g:ResourcePackage');
      res.send(xml);
    } catch (error) {
      console.error('DDI XML conversion error:', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to convert response to DDI XML format'
      });
    }
  } else {
    res.set('Content-Type', 'application/vnd.ddi.structure+json;version=3.3');
    res.json(bundle);
  }
});

// Single item by identifier (polymorphic) — same path resolution rules as type-specific item URLs
app.get('/ddi/v1/items/:itemIdentifier', (req, res) => {
  const references = req.query.references || 'none';
  const found = findItemByPathSegment(req.params.itemIdentifier, req.query);
  if (found.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: found.message
    });
  }
  if (found.error === 'notfound') {
    return res.status(404).json({ error: 'Item not found' });
  }
  const resolved = resolveReferences(found.item, references);
  sendResponse(req, res, resolved, found.xmlRoot);
});

// Variables endpoints
app.get('/ddi/v1/variables', (req, res) => {
  serveCollection(req, res, loadMock('variables.json'), 'variables', 'variables');
});

app.get('/ddi/v1/variables/:variableID', (req, res) => {
  const { variableID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('variables.json');
  const result = findResourceForRequest(data, variableID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Variable not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'variable');
});

// Concepts endpoints
app.get('/ddi/v1/concepts', (req, res) => {
  serveCollection(req, res, loadMock('concepts.json'), 'concepts', 'concepts');
});

app.get('/ddi/v1/concepts/:conceptID', (req, res) => {
  const { conceptID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('concepts.json');
  const result = findResourceForRequest(data, conceptID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Concept not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'concept');
});

// Concept Schemes endpoints
app.get('/ddi/v1/concept-schemes', (req, res) => {
  serveCollection(req, res, loadMock('concept-schemes.json'), null, 'conceptSchemes');
});

app.get('/ddi/v1/concept-schemes/:conceptSchemeID', (req, res) => {
  const { conceptSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('concept-schemes.json');
  const result = findResourceForRequest(data, conceptSchemeID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Concept scheme not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'conceptScheme');
});

// Variable Schemes endpoints
app.get('/ddi/v1/variable-schemes', (req, res) => {
  serveCollection(req, res, loadMock('variable-schemes.json'), null, 'variableSchemes');
});

app.get('/ddi/v1/variable-schemes/:variableSchemeID', (req, res) => {
  const { variableSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('variable-schemes.json');
  const result = findResourceForRequest(data, variableSchemeID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Variable scheme not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'variableScheme');
});

// Code Lists endpoints
app.get('/ddi/v1/code-lists', (req, res) => {
  serveCollection(req, res, loadMock('code-lists.json'), 'code-lists', 'codeLists');
});

app.get('/ddi/v1/code-lists/:codeListID', (req, res) => {
  const { codeListID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('code-lists.json');
  const result = findResourceForRequest(data, codeListID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Code list not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'codeList');
});

// Code List Schemes endpoints
app.get('/ddi/v1/code-list-schemes', (req, res) => {
  serveCollection(req, res, loadMock('code-list-schemes.json'), null, 'codeListSchemes');
});

app.get('/ddi/v1/code-list-schemes/:codeListSchemeID', (req, res) => {
  const { codeListSchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('code-list-schemes.json');
  const result = findResourceForRequest(data, codeListSchemeID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Code list scheme not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'codeListScheme');
});

// Category Schemes endpoints
app.get('/ddi/v1/category-schemes', (req, res) => {
  serveCollection(req, res, loadMock('category-schemes.json'), null, 'categorySchemes');
});

app.get('/ddi/v1/category-schemes/:categorySchemeID', (req, res) => {
  const { categorySchemeID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('category-schemes.json');
  const result = findResourceForRequest(data, categorySchemeID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Category scheme not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'categoryScheme');
});

// Study Units endpoints
app.get('/ddi/v1/study-units', (req, res) => {
  serveCollection(req, res, loadMock('study-units.json'), null, 'studyUnits');
});

app.get('/ddi/v1/study-units/:studyUnitID', (req, res) => {
  const { studyUnitID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('study-units.json');
  const result = findResourceForRequest(data, studyUnitID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Study unit not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'studyUnit');
});

// Physical Instances endpoints
app.get('/ddi/v1/physical-instances', (req, res) => {
  serveCollection(req, res, loadMock('physical-instances.json'), 'physical-instances', 'physicalInstances');
});

app.get('/ddi/v1/physical-instances/:physicalInstanceID', (req, res) => {
  const { physicalInstanceID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('physical-instances.json');
  const result = findResourceForRequest(data, physicalInstanceID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Physical instance not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'physicalInstance');
});

// Datasets endpoints
app.get('/ddi/v1/datasets', (req, res) => {
  serveCollection(req, res, loadMock('datasets.json'), 'datasets', 'dataSets');
});

app.get('/ddi/v1/datasets/:datasetID', (req, res) => {
  const { datasetID } = req.params;
  const references = req.query.references || 'none';
  const data = loadMock('datasets.json');
  const result = findResourceForRequest(data, datasetID, req.query);
  if (result.error === 'badrequest') {
    return res.status(400).json({
      error: 'Bad Request',
      message: result.message
    });
  }
  if (!result.item) {
    return res.status(404).json({ error: 'Dataset not found' });
  }
  const resolved = resolveReferences(result.item, references);
  sendResponse(req, res, resolved, 'dataSet');
});

// Search endpoint - Search by labels
app.get('/ddi/v1/search/labels', (req, res) => {
  const query = req.query.q;
  const lang = req.query.lang || 'en';
  const types = req.query.type ? (Array.isArray(req.query.type) ? req.query.type : [req.query.type]) : null;
  const pageSpec = parsePagination(req.query);
  if (!pageSpec.ok) {
    return res.status(400).json({
      error: 'Bad Request',
      message: pageSpec.message
    });
  }

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

  const paginatedResults = results.slice(pageSpec.offset, pageSpec.offset + pageSpec.limit);

  sendResponse(req, res, paginatedResults, 'searchResults', {
    total: results.length,
    offset: pageSpec.offset,
    limit: pageSpec.limit
  });
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
      items: {
        list: '/ddi/v1/items',
        item: '/ddi/v1/items/{itemIdentifier}'
      },
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
        supported: ['urn', 'agencyID', 'resourceID', 'version']
      },
      pagination: {
        description: 'Always applied on type-specific list endpoints and GET /search/labels. Metadata is in Content-Range and Link headers (not the DDI body). GET /items is not paginated.',
        query: {
          offset: { default: 0, description: '0-based start index' },
          limit: { default: 100, maximum: 1000, description: 'Page size' }
        },
        headers: ['Content-Range', 'Link']
      }
    }
  });
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`🚀 DDI API Mock Server running on http://127.0.0.1:${PORT}`);
  console.log(`📄 Serving mock data from: ${MOCKS_DIR}`);
  console.log(`📋 OpenAPI spec: ${SPEC_PATH}`);
});

