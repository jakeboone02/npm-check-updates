import fs from 'fs/promises'
import path from 'path'
import { parseDocument } from 'yaml'
import { Index } from '../types/IndexType'
import { VersionSpec } from '../types/VersionSpec'

/**
 * @returns String safe for use in `new RegExp()`
 */
function escapeRegexp(s: string) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')
}

/**
 * Upgrade catalog dependencies in a YAML file (e.g., pnpm-workspace.yaml).
 * Uses the yaml library to preserve comments, formatting, and structure.
 */
async function upgradeYamlCatalogData(
  filePath: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileContent = await fs.readFile(filePath, 'utf-8')
  const doc = parseDocument(fileContent)

  // Update catalog dependencies while preserving document structure
  Object.entries(upgraded)
    .filter(([dep]) => current[dep])
    .forEach(([dep, newVersion]) => {
      // Check various possible paths for catalogs
      const possiblePaths = [
        ['catalogs', 'default', dep],
        ['catalog', dep],
        // Also check for named catalogs - we'll iterate through them
      ]

      // Handle named catalogs in catalogs section
      const catalogsNode = doc.getIn(['catalogs'])
      if (catalogsNode && typeof catalogsNode === 'object') {
        // Find the catalog that contains this dependency
        for (const [catalogName, catalogContent] of Object.entries(catalogsNode as any)) {
          if (catalogContent && typeof catalogContent === 'object' && (catalogContent as any)[dep]) {
            doc.setIn(['catalogs', catalogName, dep], newVersion)
            return
          }
        }
      }

      // Try other possible paths
      for (const pathSegments of possiblePaths) {
        const value = doc.getIn(pathSegments)
        if (value !== undefined) {
          doc.setIn(pathSegments, newVersion)
          break
        }
      }
    })

  return doc.toString()
}

/**
 * Upgrade catalog dependencies in a JSON file (e.g., package.json for Bun).
 */
async function upgradeJsonCatalogData(
  filePath: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileContent = await fs.readFile(filePath, 'utf-8')

  // Use regex replacement to maintain JSON formatting
  return Object.entries(upgraded)
    .filter(([dep]) => current[dep])
    .reduce((content, [dep, newVersion]) => {
      const currentVersion = current[dep]

      // Match catalog and catalogs sections in JSON (both top-level and within workspaces)
      const catalogPattern = `("${escapeRegexp(dep)}"\\s*:\\s*")(${escapeRegexp(currentVersion)})(")`
      const catalogRegex = new RegExp(catalogPattern, 'g')

      return content.replace(catalogRegex, `$1${newVersion}$3`)
    }, fileContent)
}

/**
 * Upgrade catalog dependencies in either YAML or JSON catalog files.
 * Supports pnpm-workspace.yaml (pnpm) and package.json (Bun) catalog formats.
 *
 * @param filePath The path to the catalog file (pnpm-workspace.yaml or package.json)
 * @param current Current catalog dependencies {package: range}
 * @param upgraded New catalog dependencies {package: range}
 * @returns The updated file content as utf8 text
 */
export async function upgradeCatalogData(
  filePath: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
): Promise<string> {
  const fileExtension = path.extname(filePath)

  if (fileExtension === '.yaml' || fileExtension === '.yml') {
    return upgradeYamlCatalogData(filePath, current, upgraded)
  } else if (fileExtension === '.json') {
    return upgradeJsonCatalogData(filePath, current, upgraded)
  } else {
    throw new Error(`Unsupported catalog file type: ${filePath}`)
  }
}

export default upgradeCatalogData
