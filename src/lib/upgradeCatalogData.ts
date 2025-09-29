import { ModificationOptions, applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser'
import { parseDocument } from 'yaml'
import { Index } from '../types/IndexType'
import { VersionSpec } from '../types/VersionSpec'

/**
 * Upgrade catalog dependencies in YAML content.
 * Uses the yaml library to preserve comments, formatting, and structure.
 */
function upgradeYamlCatalogData(
  fileContent: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): string {
  const doc = parseDocument(fileContent)

  // Update catalog dependencies while preserving document structure
  Object.entries(upgraded)
    .filter(([dep]) => current[dep])
    .forEach(([dep, newVersion]) => {
      if (catalogName === 'default') {
        // Handle default catalog - check both 'catalog' and 'catalogs.default'
        const catalogValue = doc.getIn(['catalog', dep])
        if (catalogValue !== undefined) {
          doc.setIn(['catalog', dep], newVersion)
        }
        const catalogsDefaultValue = doc.getIn(['catalogs', 'default', dep])
        if (catalogsDefaultValue !== undefined) {
          doc.setIn(['catalogs', 'default', dep], newVersion)
        }
      } else {
        // Handle named catalogs in catalogs section
        const catalogValue = doc.getIn(['catalogs', catalogName, dep])
        if (catalogValue !== undefined) {
          doc.setIn(['catalogs', catalogName, dep], newVersion)
        }
      }
    })

  return doc.toString()
}

const modificationOptions: ModificationOptions = { formattingOptions: { insertSpaces: true, tabSize: 2 } }

/**
 * Upgrade catalog dependencies in JSON content (e.g., package.json for Bun).
 */
function upgradeJsonCatalogData(
  fileContent: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): string {
  const fileRoot = parseTree(fileContent)
  const workspaceNode = findNodeAtLocation(fileRoot!, ['workspaces'])
  const hasWorkspacesCatalogs =
    workspaceNode &&
    workspaceNode.type !== 'array' &&
    (findNodeAtLocation(workspaceNode, ['catalog']) || findNodeAtLocation(workspaceNode, ['catalogs']))

  return Object.entries(upgraded).reduce((content, [dep, newVersion]) => {
    const currentVersion = current[dep]
    if (currentVersion === newVersion) {
      return content
    }

    const keyPath = catalogName ? ['catalogs', catalogName, dep] : ['catalog', dep]

    let endResult = content

    if (findNodeAtLocation(fileRoot!, keyPath)) {
      const edits = modify(content, keyPath, newVersion, modificationOptions)
      endResult = applyEdits(content, edits)
    }

    if (hasWorkspacesCatalogs && findNodeAtLocation(fileRoot!, ['workspaces', ...keyPath])) {
      const edits = modify(content, ['workspaces', ...keyPath], newVersion, modificationOptions)
      endResult = applyEdits(content, edits)
    }

    return endResult
  }, fileContent)
}

/**
 * Upgrade catalog dependencies in either YAML or JSON catalog content.
 * Supports pnpm-workspace.yaml (pnpm) and package.json (Bun) catalog formats.
 *
 * @param fileContent The content of the catalog file
 * @param fileExtension The file extension (.yaml, .yml, or .json)
 * @param catalogName The name of the catalog to update ('default' for the main catalog)
 * @param current Current catalog dependencies {package: range}
 * @param upgraded New catalog dependencies {package: range}
 * @returns The updated file content as utf8 text
 */
export function upgradeCatalogData(
  fileContent: string,
  fileExtension: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): string {
  if (fileExtension === '.yaml' || fileExtension === '.yml') {
    return upgradeYamlCatalogData(fileContent, catalogName, current, upgraded)
  } else if (fileExtension === '.json') {
    return upgradeJsonCatalogData(fileContent, catalogName, current, upgraded)
  } else {
    throw new Error(`Unsupported catalog file type: ${fileExtension}`)
  }
}

export default upgradeCatalogData
