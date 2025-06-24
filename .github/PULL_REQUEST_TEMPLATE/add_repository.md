## Add New Mod Repository

### Checklist
- [ ] I have verified that my repository contains Resonite mods
- [ ] The repository has at least one release with a .dll file
- [ ] I have filled in all required fields in repositories.json
- [ ] The repository URL is a valid GitHub URL

### Repository Information
Please ensure your addition to `repositories.json` includes:
- `name`: The name of your mod
- `repository`: Full GitHub repository URL (https://github.com/username/repo)
- `description`: Brief description of what your mod does
- `category`: Mod category (e.g., "Optimization", "Gameplay", "UI", etc.)
- `author`: Your name or username
- `tags`: (Optional) Array of relevant tags
- `enabled`: (Optional) Set to false to temporarily disable

### Example Entry
```json
{
  "name": "My Awesome Mod",
  "repository": "https://github.com/myusername/my-awesome-mod",
  "description": "This mod adds awesome features to Resonite",
  "category": "Gameplay",
  "author": "MyUsername",
  "tags": ["feature", "enhancement"],
  "enabled": true
}
```

### Notes
- Only GitHub repositories are currently supported
- Your repository must have releases with .dll files attached
- The mod cache is updated periodically to fetch the latest releases