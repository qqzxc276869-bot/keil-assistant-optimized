# Change Log

All notable changes to the "keil-assistant" extension will be documented in this file.

## [v1.7.4] Manage groups and file references in VS Code
- Create a Keil group from the project or target tree item
- Add a saved `.c` or `.h` directly to a Keil group
- Remove a file reference from a Keil group without deleting the disk file

***

## [v1.7.3] Add saved C files and headers from VS Code
- Add a `.c` or `.h` file to a selected Keil project, target, and group from the VS Code Explorer or command palette
- Update only the selected XML group, reject duplicate references, and support empty groups

***

## [v1.7.2] Local optimized build
- Discover nested Keil projects without switching away from the outer VS Code workspace
- Keep manually selected projects and place IntelliSense settings in the workspace folder
- Save edited files before build and rebuild; run tasks from the Keil project directory
- Validate UV4.exe paths and avoid building a closed project with F7

***

## [v1.7.1]
- Fixed: can't use shortcut key
***

## [v1.7.0]
- Change: adjust view
- Optimize: Update doc
- Optimize: support double click to open file with non-preview mode
***

## [v1.6.2]
- Fixed: output messy code
- Optimize: extend more armcc keywords
***

## [v1.6.1]
- Fixed: error rebuild command
***

## [v1.6.0]
- New: support show source referance files
- New: add exclude list on open multi-project workspace
***

## [v1.5.0]
- New: add 'Active Target' button
- Changed: adjust keybindings
***

## [v1.4.0]
- New: support multi-target keil project
- New: add armclang cpp macros
***

## [v1.3.3]
- Optimize: extend more armcc keywords
***

## [v1.3.2]
- Fixed: some incorrect C51 keywords
- Fixed: some other bugs
***

## [v1.3.1]
- Fixed: add missed system include path
- Changed: remove c51 language highlight
- Optimized: add more system macro
***

## [v1.3.0]
- Add: switch workspace after open project
- Changed: change icon
- Fixed: build failed without workspace
***

## [v1.2.1]
- Add: Add some internal defines for ARM/C51
***

## [v1.2.0]
- Fixed: Can't run task by CMD
- Add: Shortcut keys
***

## [v1.1.0]
- Fixed: Not found C51/STM32 system include dir
- Fixed: Invalid macro
***

## [v1.0.0]
- First release
