//! Local file paths in one row of terminal text, the way a compiler, a test
//! runner, or `git status` prints them. Reading the row is all this does:
//! whether the file exists is only checked, off the UI thread, once the path
//! is clicked.
