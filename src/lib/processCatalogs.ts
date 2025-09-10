import findUp from 'find-up'
import fs from 'fs/promises'
import { Index } from '../types/IndexType'
import { Options } from '../types/Options'
import { PackageInfo } from '../types/PackageInfo'
import { VersionSpec } from '../types/VersionSpec'
import { getCatalogDependencies } from './getCurrentDependencies'
import { upgradeCatalogData } from './upgradeCatalogData'
import upgradePackageDefinitions from './upgradePackageDefinitions'

/**
 * Processes catalog dependencies for pnpm workspaces.
 *
 * @param options The options for the run
 * @param packageInfos Array of package information
 * @param catalogDependencies The catalog dependencies from pnpm-workspace.yaml or package.json
 */
export async function processCatalogs(
  options: Options,
  packageInfos: PackageInfo[],
  catalogDependencies: Index<Index<VersionSpec>> | null,
): Promise<void> {
  if (!catalogDependencies || Object.keys(catalogDependencies).length === 0) {
    return
  }

  // Collect all catalog references across all packages
  const catalogReferences: Index<Set<string>> = {}
  for (const packageInfo of packageInfos) {
    const catalogDeps = getCatalogDependencies(packageInfo.pkg, options)

    Object.entries(catalogDeps).forEach(([pkgName, catalogRef]) => {
      // catalogRef is like "catalog:mobile", extract the catalog name
      const catalogName = catalogRef.replace('catalog:', '')
      if (!catalogReferences[pkgName]) {
        catalogReferences[pkgName] = new Set()
      }
      catalogReferences[pkgName].add(catalogName)
    })
  }

  // Only check for upgrades for packages that are actually referenced by catalog dependencies
  const referencedCatalogDeps: Index<VersionSpec> = {}
  // Flatten catalog dependencies for processing
  const flattenedCatalogDeps: Index<VersionSpec> = {}
  Object.values(catalogDependencies).forEach(catalogDeps => {
    Object.assign(flattenedCatalogDeps, catalogDeps)
  })

  Object.keys(catalogReferences).forEach(pkgName => {
    if (flattenedCatalogDeps[pkgName]) {
      referencedCatalogDeps[pkgName] = flattenedCatalogDeps[pkgName]
    }
  })

  if (Object.keys(referencedCatalogDeps).length === 0) {
    return
  }

  // Check for upgrades for catalog dependencies
  const [upgradedCatalogDeps] = await upgradePackageDefinitions(referencedCatalogDeps, options)

  // If there are upgrades to apply
  if (Object.keys(upgradedCatalogDeps).length > 0) {
    // Find the catalog file to update
    let catalogFilePath: string | null = null

    if (options.packageManager === 'pnpm') {
      // Look for pnpm-workspace.yaml
      const pnpmWorkspacePath = await findUp('pnpm-workspace.yaml', { cwd: options.cwd })
      if (pnpmWorkspacePath) {
        catalogFilePath = pnpmWorkspacePath
      }
    }

    // Also check package.json for catalog information
    if (!catalogFilePath) {
      const packageJsonPath = await findUp('package.json', { cwd: options.cwd })
      if (packageJsonPath) {
        const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8')
        const packageData = JSON.parse(packageJsonContent)
        if (
          packageData.catalog ||
          packageData.catalogs ||
          (packageData.workspaces &&
            !Array.isArray(packageData.workspaces) &&
            (packageData.workspaces.catalog || packageData.workspaces.catalogs))
        ) {
          catalogFilePath = packageJsonPath
        }
      }
    }

    // Update the catalog file if found
    if (catalogFilePath && options.upgrade) {
      try {
        const updatedContent = await upgradeCatalogData(catalogFilePath, referencedCatalogDeps, upgradedCatalogDeps)
        await fs.writeFile(catalogFilePath, updatedContent, 'utf-8')
      } catch (error) {
        console.error(`Error updating catalog file ${catalogFilePath}:`, error)
      }
    }
  }
}
