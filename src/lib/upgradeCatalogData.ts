import fs from 'fs/promises'
import { ModificationOptions, applyEdits, findNodeAtLocation, modify, parseTree } from 'jsonc-parser'
import path from 'path'
import { parseDocument } from 'yaml'
import { Index } from '../types/IndexType'
import { VersionSpec } from '../types/VersionSpec'

/**
 * Upgrade catalog dependencies in a YAML file (e.g., pnpm-workspace.yaml).
 * Uses the yaml library to preserve comments, formatting, and structure.
 */
async function upgradeYamlCatalogData(
  filePath: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileContent = await fs.readFile(filePath, 'utf-8')
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
 * Upgrade catalog dependencies in a JSON file (e.g., package.json for Bun).
 */
async function upgradeJsonCatalogData(
  filePath: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileContent = await fs.readFile(filePath, 'utf-8')
  const fileData = JSON.parse(fileContent)
  const fileRoot = parseTree(fileContent)
  const hasWorkspacesCatalog = fileData.workspaces && !Array.isArray(fileData.workspaces) && fileData.workspaces.catalog
  const hasWorkspacesCatalogs =
    fileData.workspaces && !Array.isArray(fileData.workspaces) && fileData.workspaces.catalogs

  return Object.entries(upgraded).reduce((content, [dep, newVersion]) => {
    const currentVersion = current[dep]
    if (currentVersion === newVersion) {
      return content
    }

    const keyPath =
      catalogName === 'default' ? ['catalog', dep] : ['catalogs', catalogName, dep]

    let endResult = content

    if (findNodeAtLocation(fileRoot!, keyPath)) {
      const edits = modify(content, keyPath, newVersion, modificationOptions)
      endResult = applyEdits(content, edits)
    }

    if (
      ((hasWorkspacesCatalog && catalogName === 'default') ||
        (hasWorkspacesCatalogs && catalogName !== 'default')) &&
      findNodeAtLocation(fileRoot!, ['workspaces', ...keyPath])
    ) {
      const edits = modify(content, ['workspaces', ...keyPath], newVersion, modificationOptions)
      endResult = applyEdits(content, edits)
    }

    return endResult
  }, fileContent)
}

/**
 * Upgrade catalog dependencies in either YAML or JSON catalog files.
 * Supports pnpm-workspace.yaml (pnpm) and package.json (Bun) catalog formats.
 *
 * @param filePath The path to the catalog file (pnpm-workspace.yaml or package.json)
 * @param catalogName The name of the catalog to update ('default' for the main catalog)
 * @param current Current catalog dependencies {package: range}
 * @param upgraded New catalog dependencies {package: range}
 * @returns The updated file content as utf8 text
 */
export async function upgradeCatalogData(
  filePath: string,
  catalogName: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileExtension = path.extname(filePath)

  if (fileExtension === '.yaml' || fileExtension === '.yml') {
    return upgradeYamlCatalogData(filePath, catalogName, current, upgraded)
  } else if (fileExtension === '.json') {
    return upgradeJsonCatalogData(filePath, catalogName, current, upgraded)
  } else {
    throw new Error(`Unsupported catalog file type: ${filePath}`)
  }
}

export default upgradeCatalogData
