# Renaming Project to "pair-trading"

## Steps to Rename the Folder

### Option 1: Using Terminal (Recommended)

```bash
# Navigate to parent directory
cd ..

# Rename the folder
mv cluster pair-trading

# Navigate into renamed folder
cd pair-trading
```

### Option 2: Using Finder (macOS)

1. Close any open terminals/editors using this folder
2. Navigate to parent directory in Finder
3. Right-click on `cluster` folder
4. Select "Rename"
5. Type `pair-trading`

## What's Already Updated

✅ `package.json` - Project name changed to "pair-trading"
✅ `README.md` - Updated header
✅ All internal references use relative paths (no hardcoded folder names)

## After Renaming

1. **Update your terminal/editor** - Open the new `pair-trading` folder
2. **Test the scripts:**
   ```bash
   npm run analyze HYPE ZEC long
   ```
3. **If using Git:**
   ```bash
   # If you have a remote, update it:
   git remote set-url origin <new-repo-url>
   ```

## Verification

After renaming, verify everything works:

```bash
# Check package.json
cat package.json | grep name

# Should show: "name": "pair-trading"

# Test a script
npm run analyze HYPE ZEC long
```

---

**Note:** All file paths in the codebase use relative paths, so no code changes are needed after renaming the folder.

