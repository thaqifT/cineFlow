# Playing a Cineflow cutscene in your game

Cineflow edits cutscenes on the desktop. To make one play **in the place itself** (walk into a
part → camera + animations run for that player), the plugin writes four small things into the
place. Nothing else is required, and all of it is undoable Studio actions.

## One click

In the Cineflow panel inside Studio:

1. **Connect to desktop app** (bridge must be running in the app).
2. **Install player runtime to game** — writes the runtime + the active cutscene data.
3. **Add touch trigger to place** — writes a pad, a ProximityPrompt and a script that plays the
   active cutscene for whoever touches or activates it.

Press Play in Studio and walk onto `Workspace.CineflowData.TouchTrigger`.

## What gets written

| Instance | Purpose |
| --- | --- |
| `ReplicatedStorage.CineflowCutscenes.<cutsceneId>` | StringValue holding the cutscene JSON (tracks, clips, camera keyframes, recording anchor). |
| `ReplicatedStorage.CineflowPlayCamera` | RemoteEvent the server fires to start/stop a player's camera. |
| `ServerScriptService.CineflowRuntime` | ModuleScript that plays clips: animations, trigger clips, camera. |
| `StarterPlayer.StarterPlayerScripts.CineflowCameraRuntime` | LocalScript that applies camera keyframes on the client. |
| `Workspace.CineflowData.TouchTrigger` | The physical pad. `Anchored`, walk-through, neon. |
| `Workspace.CineflowData.TouchTrigger.CineflowTrigger` | Server Script with a 6-second per-player cooldown. |
| `Workspace.CineflowData.CameraAnchor` | Red neon cube marking the spot a camera take was recorded from. |

## Runtime API

```lua
local Runtime = require(game:GetService("ServerScriptService"):WaitForChild("CineflowRuntime"))

Runtime.Play(cutsceneTable)            -- play for the server (animations / trigger clips)
Runtime.PlaySaved("cutsceneId")        -- same, loading JSON from ReplicatedStorage
Runtime.PlayForPlayer(cutsceneTable, player)   -- play + send the camera to one player
Runtime.PlaySavedForPlayer("cutsceneId", player)
```

Only the player passed to `PlayForPlayer` / `PlaySavedForPlayer` gets the camera move; everyone
else keeps their normal camera. Animations play server-side and replicate normally.

## Doing it by hand

1. Build the cutscene in the desktop app and press Preview until it looks right.
2. In Studio: **Install player runtime to game**.
3. Any `BasePart` + `ProximityPrompt` of your own works — putting the generated trigger script
   under any part is enough. Change `CUTSCENE` at the top to the StringValue name.

```lua
local Runtime = require(game:GetService("ServerScriptService"):WaitForChild("CineflowRuntime"))
local CUTSCENE = "my-cutscene-id"   -- name under ReplicatedStorage.CineflowCutscenes

workspace:WaitForChild("TriggerPad").Touched:Connect(function(hit)
    local character = hit.Parent
    local humanoid = character and character:FindFirstChildOfClass("Humanoid")
    if not humanoid then return end
    local player = game:GetService("Players"):GetPlayerFromCharacter(character)
    if player then Runtime.PlaySavedForPlayer(CUTSCENE, player) end
end)
```

## Prompt for the Studio AI assistant

Paste this into Studio's AI assistant (or a code assistant) if you want it wired into an existing
map instead of using the generated pad:

```text
Automate a Cineflow cutscene trigger in this place.

Assets that already exist (create them only if missing, never overwrite):
- ReplicatedStorage.CineflowCutscenes.<id>  StringValue containing cutscene JSON
- ReplicatedStorage.CineflowPlayCamera     RemoteEvent
- ServerScriptService.CineflowRuntime      ModuleScript with:
  Play(cutscene), PlaySaved(name), PlayForPlayer(cutscene, player), PlaySavedForPlayer(name, player)

Do this:
1. Find the BasePart named "CutsceneStone" in Workspace. If missing, create a 6x1x6 anchored,
   non-collidable, neon part at ground level near spawn and name it CutsceneStone.
2. Add a ProximityPrompt to it: ActionText "Watch", ObjectText the cutscene name, HoldDuration 0,
   MaxActivationDistance 12, RequiresLineOfSight false.
3. Add a server Script named CineflowTrigger under the part that:
   - requires ServerScriptService.CineflowRuntime
   - defines CUTSCENE = "<id>" and COOLDOWN = 6
   - plays Runtime.PlaySavedForPlayer(CUTSCENE, player) for the touching/activating player
   - ignores non-Humanoid hits, ignores players still on cooldown, and wraps the call in pcall
     with warn("[Cineflow] " .. err) on failure
4. Do not change the camera, lighting, or any other part of the map.
5. Report the instance paths you created.
```

## Notes and limits

- **Camera takes are anchored.** A take stores the `CFrame` it was recorded from
  (`CameraAnchor` in the workspace). Preview replays from that spot even if you have since flown
  the camera somewhere else; re-record from the new spot to move it.
- **The app's viewport is a proxy**, not a pixel stream. Studio cannot hand a plugin rendered
  frames, so the app receives the live camera transform plus the nearest ~48 parts and draws them
  as wireframe boxes. It is for framing and motion feedback; the real image is in Studio.
- Trigger clips in the timeline are editor-side markers today — they stamp
  `CineflowTriggered` attributes in Studio preview. In-game use the script above.
- Camera clips need either `keyframes` or a single `rotation`; without them the runtime leaves the
  player's camera untouched.
