import fs from 'fs/promises'
import path from 'path'
import { parse } from 'yaml'
import { Index } from '../types/IndexType'
import { Options } from '../types/Options'
import { PackageFile } from '../types/PackageFile'
import { VersionSpec } from '../types/VersionSpec'
import resolveDepSections from './resolveDepSections'
import upgradeCatalogData from './upgradeCatalogData'

/**
 * @returns String safe for use in `new RegExp()`
 */
function escapeRegexp(s: string) {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') // Thanks Stack Overflow!
}

/**
 * Upgrade the dependency declarations in the package data.
 *
 * @param pkgData The package.json data, as utf8 text
 * @param oldDependencies Old dependencies {package: range}
 * @param newDependencies New dependencies {package: range}
 * @param options Options object
 * @param pkgFile Optional path to the package file
 * @returns The updated package data, as utf8 text
 * @description Side Effect: prompts
 */
async function upgradePackageData(
  pkgData: string,
  current: Index<VersionSpec>,
  upgraded: Index<VersionSpec>,
  options: Options,
  pkgFile?: string,
) {
  // Early return if no upgrades to apply
  if (Object.keys(upgraded).length === 0) {
    return pkgData
  }
  // Check if this is a catalog file (pnpm-workspace.yaml or package.json with catalogs)
  if (pkgFile) {
    const fileName = path.basename(pkgFile)
    const fileExtension = path.extname(pkgFile)

    // Handle synthetic catalog files (package.json#catalog format)
    if (pkgFile.includes('#catalog:')) {
      // This is a synthetic catalog file, we need to read and update the actual file
      const actualFilePath = pkgFile.replace(/#catalog:.*/, '')
      const actualFileExtension = path.extname(actualFilePath)

      if (actualFileExtension === '.json') {
        // Bun format: update package.json catalogs and return the updated content
        const catalogName = pkgFile.match(/#catalog:(.*)/)![1]
        const actualFileContent = await fs.readFile(actualFilePath, 'utf-8')
        return upgradeCatalogData(actualFileContent, actualFileExtension, catalogName, current, upgraded)
      }
    }

    // Handle pnpm-workspace.yaml catalog files
    if (fileName === 'pnpm-workspace.yaml') {
      // Check if we have synthetic catalog data (JSON with only dependencies and name/version)
      // In this case, we should generate the proper catalog structure
      const parsed = JSON.parse(pkgData)
      if (
        typeof parsed === 'object' &&
        /^catalog-.*-dependencies$/.test(parsed.name) &&
        typeof parsed.dependencies === 'object' &&
        Object.keys(parsed).length <= 3
      ) {
        // This is synthetic catalog data, we need to generate the proper catalog structure
        // Read the original pnpm-workspace.yaml to get the catalog structure
        const yamlContent = await fs.readFile(pkgFile, 'utf-8')
        const yamlData = parse(yamlContent) as {
          packages?: string[]
          catalog?: Index<string>
          catalogs?: Index<Index<string>>
        }

        // Update catalog dependencies with upgraded versions
        if (yamlData.catalogs) {
          yamlData.catalogs = Object.entries(yamlData.catalogs).reduce(
            (catalogs, [catalogName, catalog]) => ({
              ...catalogs,
              [catalogName]: {
                ...catalog,
                ...Object.entries(upgraded)
                  .filter(([dep]) => catalog[dep])
                  .reduce((acc, [dep, version]) => ({ ...acc, [dep]: version }), {}),
              },
            }),
            {} as typeof yamlData.catalogs,
          )
        }

        // Also handle single catalog (if present)
        if (yamlData.catalog) {
          const catalog = yamlData.catalog
          yamlData.catalog = {
            ...catalog,
            ...Object.entries(upgraded)
              .filter(([dep]) => catalog[dep])
              .reduce((acc, [dep, version]) => ({ ...acc, [dep]: version }), {}),
          }
        }

        // For pnpm, also expose the 'default' catalog as a top-level 'catalog' property
        if (yamlData.catalogs?.default) {
          yamlData.catalog = yamlData.catalogs.default
        }

        return JSON.stringify(yamlData, null, 2)
      }

      const catalogName = parsed.name.replace(/^catalog-/, '').replace(/-dependencies$/, '')
      const yamlContent = await fs.readFile(pkgFile, 'utf-8')
      return upgradeCatalogData(yamlContent, path.extname(pkgFile), catalogName, current, upgraded)
    }

    // Handle package.json catalog files (check if content contains catalog/catalogs at root level or in workspaces)
    if (fileExtension === '.json') {
      const parsed = JSON.parse(pkgData)
      const hasTopLevelCatalogs = parsed.catalog || parsed.catalogs
      const hasWorkspacesCatalogs =
        parsed.workspaces &&
        !Array.isArray(parsed.workspaces) &&
        (parsed.workspaces.catalog || parsed.workspaces.catalogs)

      if (hasTopLevelCatalogs || hasWorkspacesCatalogs) {
        // For package.json catalogs, assume 'default' catalog if not specified
        const catalogName = 'default'
        const fileContent = await fs.readFile(pkgFile, 'utf-8')
        return upgradeCatalogData(fileContent, fileExtension, catalogName, current, upgraded)
      }
    }
  }

  // Always include overrides since any upgraded dependencies needed to be upgraded in overrides as well.
  // https://github.com/raineorshine/npm-check-updates/issues/1332
  const depSections = [...resolveDepSections(options.dep), 'overrides']

  // iterate through each dependency section
  const sectionRegExp = new RegExp(`"(${depSections.join(`|`)})"\\s*:[^}]*`, 'g')
  let newPkgData = pkgData.replace(sectionRegExp, section => {
    // replace each upgraded dependency in the section
    return Object.entries(upgraded).reduce((updatedSection, [dep]) => {
      // const expression = `"${dep}"\\s*:\\s*"(${escapeRegexp(current[dep])})"`
      const expression = `"${dep}"\\s*:\\s*("|{\\s*"."\\s*:\\s*")(${escapeRegexp(current[dep])})"`
      const regExp = new RegExp(expression, 'g')
      return updatedSection.replace(regExp, (match, child) => `"${dep}${child ? `": ${child}` : ': '}${upgraded[dep]}"`)
    }, section)
  })

  if (depSections.includes('packageManager')) {
    const pkg = JSON.parse(pkgData) as PackageFile
    if (pkg.packageManager) {
      const [name] = pkg.packageManager.split('@')
      if (upgraded[name]) {
        newPkgData = newPkgData.replace(
          /"packageManager"\s*:\s*".*?@[^"]*"/,
          `"packageManager": "${name}@${upgraded[name]}"`,
        )
      }
    }
  }

  return newPkgData
}

export default upgradePackageData
