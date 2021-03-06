/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        FSAL directory functions
 * CVM-Role:        Utility function
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file contains utility functions for dealing with directories.
 *
 * END HEADER
 */

const path = require('path')
const fs = require('fs').promises
const hash = require('../../../common/util/hash')
const sort = require('../../../common/util/sort')
const isDir = require('../../../common/util/is-dir')
const isFile = require('../../../common/util/is-file')
const ignoreDir = require('../../../common/util/ignore-dir')
const ignoreFile = require('../../../common/util/ignore-file')
const safeAssign = require('../../../common/util/safe-assign')
const isAttachment = require('../../../common/util/is-attachment')

const { shell } = require('electron')

const FSALFile = require('./fsal-file')
const FSALAttachment = require('./fsal-attachment')

/**
 * Determines what will be written to file (.ztr-directory)
 */
const SETTINGS_TEMPLATE = {
  'sorting': 'name-up',
  'project': null // Default: no project
}

/**
 * Used to insert a default project
 */
const PROJECT_TEMPLATE = {
  // General values that not only pertain to the PDF generation
  'title': 'Untitled', // Default project title is the directory's name
  'format': 'pdf', // Can be PDF, HTML, DOCX, and ODT.
  'cslStyle': '', // A path to an optional CSL style file.
  'pdf': {
    'author': 'Generated by Zettlr',
    // PDF keywords are seldomly used
    'keywords': '',
    // papertype is a value that XeLaTeX expects
    'papertype': 'a4paper',
    // pagenumbering must also be a value that XeLaTeX accepts
    'pagenumbering': 'arabic',
    // All four paper margins
    'tmargin': 3,
    'rmargin': 3,
    'bmargin': 3,
    'lmargin': 3,
    'margin_unit': 'cm',
    'lineheight': '1.2', // TODO: Why is this a string?
    'mainfont': 'Times New Roman',
    'sansfont': 'Arial',
    'fontsize': 12,
    'toc': true, // Default: generate table of contents
    'tocDepth': 2, // Default: Include headings 1+2 in TOCs
    'titlepage': true, // Generate a title page by default
    'textpl': '' // Can be used to store a custom TeX template
  }
}

/**
 * Allowed child sorting methods
 */
const SORTINGS = [
  'name-up',
  'name-down',
  'time-up',
  'time-down'
]

/**
 * This function returns a sanitized, non-circular
 * version of dirObject.
 * @param {Object} dirObject A directory descriptor
 */
function metadata (dirObject) {
  // Handle the children
  let children = dirObject.children.map((elem) => {
    if (elem.type === 'directory') {
      return metadata(elem)
    } else if (elem.type === 'file') {
      return FSALFile.metadata(elem)
    }
  })

  return {
    // By only passing the hash, the object becomes
    // both lean AND it can be reconstructed into a
    // circular structure with NO overheads in the
    // renderer.
    'parent': (dirObject.parent) ? dirObject.parent.hash : null,
    'path': dirObject.path,
    'name': dirObject.name,
    'hash': dirObject.hash,
    // The project itself is not needed, renderer only checks if it equals
    // null, or not (then it means there is a project)
    'project': (dirObject._settings.project) ? true : null,
    'children': children,
    'attachments': dirObject.attachments.map(elem => FSALAttachment.metadata(elem)),
    'type': dirObject.type,
    'sorting': dirObject._settings.sorting,
    'modtime': dirObject.modtime
  }
}

/**
 * Sorts the children-property of "dir"
 * @param {Object} dir A directory descriptor
 */
function sortChildren (dir) {
  dir.children = sort(dir.children, dir._settings.sorting)
}

/**
 * Persists the settings of a directory to disk.
 * @param {Object} dir The directory descriptor
 */
async function persistSettings (dir) {
  // Only persist the settings if they are not default
  if (JSON.stringify(dir._settings) === JSON.stringify(SETTINGS_TEMPLATE)) return
  await fs.writeFile(path.join(dir.path, '.ztr-directory'), JSON.stringify(dir._settings))
}

/**
 * Parses a settings file for the given directory.
 * @param {Object} dir The directory descriptor.
 */
async function parseSettings (dir) {
  let configPath = path.join(dir.path, '.ztr-directory')
  try {
    let settings = await fs.readFile(configPath, { encoding: 'utf8' })
    settings = JSON.parse(settings)
    dir._settings = safeAssign(settings, SETTINGS_TEMPLATE)
    if (settings.project) {
      // We have a project, so we need to sanitize the values (in case
      // that there have been changes to the config). We'll just use
      // the code from the config provider.
      dir._settings.project = safeAssign(settings.project, PROJECT_TEMPLATE)
    }
    if (JSON.stringify(dir._settings) === JSON.stringify(SETTINGS_TEMPLATE)) {
      // The settings are the default, so no need to write them to file
      await fs.unlink(configPath)
    }
  } catch (e) {
    // No (specific) settings
    // As the file exists, but something was wrong, let's remove this remnant.
    await fs.unlink(configPath)
  }
}

/**
 * Reads in a file tree recursively, returning the directory descriptor object.
 * @param {String} currentPath The current path of the directory
 * @param {FSALCache} cache A cache object so that the files can cache themselves
 * @param {Mixed} parent A parent (or null, if it's a root)
 */
async function readTree (currentPath, cache, parent) {
  // Prepopulate
  let dir = {
    'parent': parent,
    'path': currentPath,
    'name': path.basename(currentPath),
    'hash': hash(currentPath),
    'children': [],
    'attachments': [],
    'type': 'directory',
    'modtime': 0, // You know when something has gone wrong: 01.01.1970
    '_settings': JSON.parse(JSON.stringify(SETTINGS_TEMPLATE))
  }

  // Retrieve the metadata
  try {
    let stats = await fs.lstat(dir.path)
    dir.modtime = stats.ctimeMs
  } catch (e) {
    global.log.error(`Error reading metadata for directory ${dir.path}!`, e)
    // Re-throw so that the caller knows something's afoul
    throw new Error(e)
  }

  // Now parse the directory contents recursively
  let children = await fs.readdir(dir.path)
  for (let child of children) {
    if (isFile(path.join(dir.path, child)) && child === '.ztr-directory') {
      // We got a settings file, so let's try to read it in
      await parseSettings(dir)
      continue // Done!
    }

    if (isFile(path.join(dir.path, child)) && child === '.ztr-project') {
      global.log.info(`Found .ztr-project file in directory ${dir.name} - migrating!`)
      let projectFile = await fs.readFile(path.join(dir.path, child), { encoding: 'utf8' })
      projectFile = JSON.parse(projectFile)
      dir._settings.project = safeAssign(projectFile, PROJECT_TEMPLATE)
      // Make sure to persist the new settings to disk!
      await persistSettings(dir)
      // Finally unlink the "old" file
      await fs.unlink(path.join(dir.path, child))
    }

    // Helper vars
    let absolutePath = path.join(dir.path, child)
    let isInvalidDir = isDir(absolutePath) && ignoreDir(absolutePath)
    let isInvalidFile = isFile(absolutePath) && ignoreFile(absolutePath)

    // Is the child invalid?
    if (isInvalidDir || (isInvalidFile && !isAttachment(absolutePath))) continue

    // Parse accordingly
    if (isAttachment(absolutePath)) {
      dir.attachments.push(await FSALAttachment.parse(absolutePath))
    } else if (isFile(absolutePath)) {
      dir.children.push(await FSALFile.parse(absolutePath, cache, dir))
    } else if (isDir(absolutePath)) {
      dir.children.push(await readTree(absolutePath, cache, dir))
    }
  }

  // Finally sort and return the directory object
  sortChildren(dir)
  return dir
}

module.exports = {
  'parse': async function (dirPath, cache, parent = null) {
    return readTree(dirPath, cache, parent)
  },
  'metadata': function (dirObject) {
    return metadata(dirObject)
  },
  'createFile': async function (dirObject, options, cache) {
    let filename = options.name
    let content = options.content || ''
    let fullPath = path.join(dirObject.path, filename)
    await fs.writeFile(fullPath, content)
    let file = await FSALFile.parse(fullPath, cache, dirObject)
    dirObject.children.push(file)
    sortChildren(dirObject)
  },
  'sort': async function (dirObject, method) {
    // If the caller omits the method, it should remain unchanged
    if (!method) method = dirObject._settings.sorting
    if (!SORTINGS.includes(method)) throw new Error('Unknown sorting: ' + method)
    dirObject._settings.sorting = method
    // Persist the settings to disk
    await persistSettings(dirObject)
    sortChildren(dirObject)
  },
  /**
   * Assigns new project properties to a directory.
   * @param {Object} dirObject Directory descriptor
   * @param {Object} properties New properties
   */
  'updateProjectProperties': async function (dirObject, properties) {
    dirObject._settings.project = safeAssign(properties, dirObject._settings.project)
    // Immediately reflect on disk
    await persistSettings(dirObject)
  },
  // Makes a new project
  'makeProject': async function (dirObject, properties) {
    dirObject._settings.project = safeAssign(properties, PROJECT_TEMPLATE)
    await persistSettings(dirObject)
  },
  // Removes a project
  'removeProject': async function (dirObject) {
    dirObject._settings.project = null
    await persistSettings(dirObject)
  },
  'create': async function (dirObject, options, cache) {
    if (!options.name || options.name.trim() === '') throw new Error('Invalid directory name provided!')
    let existingDir = dirObject.children.find(elem => elem.name === options.name)
    if (existingDir) throw new Error(`Directory ${options.name} already exists!`)
    let newPath = path.join(dirObject.path, options.name)
    await fs.mkdir(newPath)
    let newDir = await readTree(newPath, cache, dirObject)
    // Add the new directory to the source dir
    dirObject.children.push(newDir)
    sortChildren(dirObject)
  },
  'rename': async function (dirObject, info, cache) {
    // Check some things beforehand
    if (!info.name || info.name.trim() === '') throw new Error('Invalid directory name provided!')
    let existingDir = dirObject.parent.children.find(elem => elem.name === info.name)
    if (existingDir) throw new Error(`Directory ${info.name} already exists!`)

    let newPath = path.join(dirObject.parent.path, info.name)
    await fs.rename(dirObject.path, newPath)
    // Rescan the new dir to get all new file information
    let newDir = await readTree(newPath, cache, dirObject.parent)
    // Exchange the directory in the parent
    let index = dirObject.parent.children.indexOf(dirObject)
    dirObject.parent.children.splice(index, 1, newDir)
    // Now sort the parent
    sortChildren(dirObject.parent)
  },
  'remove': async function (dirObject) {
    // First, get the parent, if there is any
    let parentDir = dirObject.parent
    // Now, remove the directory
    if (shell.moveItemToTrash(dirObject.path) && parentDir) {
      // Splice it from the parent directory
      parentDir.children.splice(parentDir.children.indexOf(dirObject), 1)
    }
  },
  'move': async function (sourceObject, targetDir, cache) {
    // Moves anything into the target. We'll use fs.rename for that.
    // Luckily, it doesn't care if it's a directory or a file, so just
    // stuff the path into that.
    let sourcePath = sourceObject.path
    let targetPath = path.join(targetDir.path, sourceObject.name)
    await fs.rename(sourcePath, targetPath)

    // Now remove the source from its parent (which in any case is a directory)
    let oldChildren = sourceObject.parent.children
    oldChildren.splice(oldChildren.indexOf(sourceObject), 1)

    // Re-read the source
    let newSource
    if (sourceObject.type === 'directory') {
      newSource = await readTree(targetPath, cache, targetDir)
    } else {
      newSource = await FSALFile.parse(targetPath, cache, targetDir)
    }

    // Add it to the new target
    targetDir.children.push(newSource)

    // Finally resort the target. Now the state should be good to go.
    sortChildren(targetDir)
  }
}
