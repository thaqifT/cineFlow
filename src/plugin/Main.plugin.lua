--!strict
-- Export this plugin from Cineflow Desktop and install through Studio > Plugins > Save as Local Plugin.
-- Enable Studio plugin HTTP requests in Studio settings; Cineflow runs only on the local machine.
local HttpService = game:GetService("HttpService")
local RunService = game:GetService("RunService")
local Workspace = game:GetService("Workspace")
local Selection = game:GetService("Selection")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local toolbar = plugin:CreateToolbar("Cineflow")
local openButton = toolbar:CreateButton("Cineflow", "Open Cineflow cutscene bridge", "")
openButton.ClickableWhenViewportHidden = true
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Left, true, false, 380, 380, 310, 250)
local widget = plugin:CreateDockWidgetPluginGuiAsync("CineflowStudioPanel", widgetInfo)
widget.Title = "Cineflow Studio"

-- Graphite + ember palette. Mirrors the desktop app's design tokens so the panel
-- and the app read as one product: ember = actions, live = connection status,
danger = destructive/record, warm off-white text on a near-black graphite ramp.
local PAL = {
	bg = Color3.fromRGB(13, 15, 19),
	panel = Color3.fromRGB(20, 23, 29),
	raised = Color3.fromRGB(27, 31, 39),
	line = Color3.fromRGB(38, 43, 51),
	lineStrong = Color3.fromRGB(51, 58, 68),
	text = Color3.fromRGB(231, 228, 223),
	text2 = Color3.fromRGB(169, 176, 186),
	muted = Color3.fromRGB(131, 140, 154),
	ember = Color3.fromRGB(240, 166, 60),
	live = Color3.fromRGB(126, 224, 176),
	danger = Color3.fromRGB(255, 95, 77),
	warn = Color3.fromRGB(239, 185, 104),
	onAccent = Color3.fromRGB(27, 19, 9),
}

local stateLabel: TextLabel
local connectButton: TextButton
local playButton: TextButton
local stopButton: TextButton
local aimButton: TextButton
local installRuntimeButton: TextButton
local baseUrl: string? = nil
local token: string? = nil
local liveAim = true
local lastPhoneConnected = false
local lastMotionSequence = 0
local cutscene: any = nil
local cutsceneRevision = -1
local previewStartedAt = 0
local previewPlayhead = 0
local previewing = false
local recording = false
local samples: {any} = {}
local previewModels: {[string]: Model} = {}
local oldCameraType: Enum.CameraType? = nil
local oldCameraSubject: Instance? = nil
local oldCameraCFrame: CFrame? = nil
local oldCameraFov: number? = nil
local cameraKeyframes: {any} = {}
local previewConnection: RBXScriptConnection? = nil
local sampleStartTimestamp: number? = nil

local lastTakeMotionSequence = 0
local animationEntries: {any} = {}

-- Where a take was physically recorded from in the workspace. Written into the
-- take and every keyframe so playback always replays that spot, no matter where
-- the editor camera happens to be when Preview is pressed.
local cameraAnchor: CFrame? = nil
local previewPushAt = 0
local previewWasPushing = false
local markAnchor: (cf: CFrame) -> ()

-- CFrames travel through the desktop app as plain JSON, so they cross as the
-- same 12 numbers CFrame:GetComponents() returns.
local function cframeToList(cf: CFrame): {number}
	local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = cf:GetComponents()
	return {x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22}
end

local function listToCFrame(list: any): CFrame?
	if type(list) ~= "table" or #list < 12 then return nil end
	for index = 1, 12 do
		if tonumber(list[index]) == nil then return nil end
	end
	return CFrame.new(
		tonumber(list[1]), tonumber(list[2]), tonumber(list[3]),
		tonumber(list[4]), tonumber(list[5]), tonumber(list[6]),
		tonumber(list[7]), tonumber(list[8]), tonumber(list[9]),
		tonumber(list[10]), tonumber(list[11]), tonumber(list[12])
	)
end

-- Two most recent phone samples, with local receive times. Interpolating between
-- them keeps the camera smooth even when the bridge only delivers a few samples
-- per second, and uses local clocks so desktop/Studio clock skew cannot matter.
local motionOlder: any = nil
local motionNewer: any = nil

local function pushMotion(alpha: number, beta: number, gamma: number)
	if motionNewer then motionOlder = motionNewer end
	motionNewer = {alpha = alpha, beta = beta, gamma = gamma, at = os.clock()}
end

local function clearMotion()
	motionOlder, motionNewer = nil, nil
end

local function lerpAngle(from: number, to: number, weight: number): number
	local delta = ((to - from + 540) % 360) - 180
	return from + delta * weight
end

local function liveRotation(): any
	if not motionNewer then return nil end
	if not motionOlder then return motionNewer end
	local span = math.max(1 / 240, motionNewer.at - motionOlder.at)
	local weight = math.clamp((os.clock() - motionNewer.at) / span, 0, 1)
	return {
		alpha = lerpAngle(motionOlder.alpha, motionNewer.alpha, weight),
		beta = motionOlder.beta + (motionNewer.beta - motionOlder.beta) * weight,
		gamma = motionOlder.gamma + (motionNewer.gamma - motionOlder.gamma) * weight
	}
end

local function make(className: string, props: {[string]: any}, parent: Instance): Instance
	local object = Instance.new(className)
	for key, value in pairs(props) do (object :: any)[key] = value end
	object.Parent = parent
	return object
end

local root = make("Frame", {BackgroundColor3 = PAL.bg, BorderSizePixel = 0, Size = UDim2.fromScale(1, 1)}, widget) :: Frame
make("UIPadding", {PaddingTop = UDim.new(0, 14), PaddingBottom = UDim.new(0, 14), PaddingLeft = UDim.new(0, 14), PaddingRight = UDim.new(0, 14)}, root)
make("UIListLayout", {Padding = UDim.new(0, 9), SortOrder = Enum.SortOrder.LayoutOrder}, root)
make("TextLabel", {Name = "Title", BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 28), Font = Enum.Font.GothamBold, Text = "CINEFLOW  /  STUDIO BRIDGE", TextColor3 = PAL.text, TextSize = 16, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 1}, root)
local statusFrame = make("Frame", {Name = "Status", BackgroundColor3 = PAL.panel, BorderSizePixel = 0, Size = UDim2.new(1, 0, 0, 90), LayoutOrder = 2}, root) :: Frame
make("UIPadding", {PaddingTop = UDim.new(0, 8), PaddingBottom = UDim.new(0, 8), PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 10)}, statusFrame)
make("UIListLayout", {Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder}, statusFrame)
local statusRows: {[string]: TextLabel} = {}
local statusDots: {[string]: Frame} = {}
local function addStatusRow(key: string, caption: string, order: number)
	local row = make("Frame", {Name = key, BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 15), LayoutOrder = order}, statusFrame)
	local dot = make("Frame", {Name = "Dot", BackgroundColor3 = PAL.muted, BorderSizePixel = 0, Size = UDim2.new(0, 6, 0, 6), Position = UDim2.new(0, 0, 0.5, -3)}, row) :: Frame
	local label = make("TextLabel", {Name = "Value", BackgroundTransparency = 1, Position = UDim2.new(0, 14, 0, 0), Size = UDim2.new(1, -14, 1, 0), Font = Enum.Font.Gotham, Text = caption, TextColor3 = PAL.text2, TextSize = 11, TextXAlignment = Enum.TextXAlignment.Left, TextTruncate = Enum.TextTruncate.AtEnd}, row) :: TextLabel
	statusRows[key] = label
	statusDots[key] = dot
end
addStatusRow("desktop", "Desktop bridge — not connected", 1)
addStatusRow("studio", "Studio link — idle", 2)
addStatusRow("phone", "Phone camera — offline", 3)
addStatusRow("cutscene", "Cutscene — none loaded", 4)

local function setRow(key: string, text: string, live: boolean?)
	local label = statusRows[key]
	if label then label.Text = text end
	local dot = statusDots[key]
	if not dot then return end
	if live == true then dot.BackgroundColor3 = PAL.live
	elseif live == false then dot.BackgroundColor3 = PAL.danger
	else dot.BackgroundColor3 = PAL.muted end
end

stateLabel = make("TextLabel", {Name = "State", BackgroundColor3 = PAL.panel, BorderSizePixel = 0, Size = UDim2.new(1, 0, 0, 40), Font = Enum.Font.Gotham, Text = "Desktop bridge disconnected", TextColor3 = PAL.text2, TextSize = 12, TextWrapped = true, LayoutOrder = 3}, root) :: TextLabel
-- Two button tiers: ember for the one primary action, graphite for everything else.
local function styleButton(button: TextButton, variant: string)
	button.BackgroundColor3 = if variant == "primary" then PAL.ember else PAL.raised
	button.BorderSizePixel = if variant == "primary" then 0 else 1
	button.BorderColor3 = PAL.lineStrong
	button.Font = Enum.Font.GothamSemibold
	button.TextColor3 = if variant == "primary" then PAL.onAccent else PAL.text2
	button.TextSize = 11
end
local function styleConnected(button: TextButton)
	button.BackgroundColor3 = PAL.raised
	button.BorderSizePixel = 1
	button.BorderColor3 = PAL.live
	button.TextColor3 = PAL.live
end
connectButton = make("TextButton", {Name = "Connect", Size = UDim2.new(1, 0, 0, 36), Text = "Connect to desktop app", LayoutOrder = 4}, root) :: TextButton
styleButton(connectButton, "primary")
playButton = make("TextButton", {Name = "Play", Size = UDim2.new(1, 0, 0, 36), Text = "Preview cutscene in Studio", LayoutOrder = 5}, root) :: TextButton
styleButton(playButton, "secondary")
stopButton = make("TextButton", {Name = "Stop", Size = UDim2.new(1, 0, 0, 34), Text = "Nothing playing", LayoutOrder = 6}, root) :: TextButton
styleButton(stopButton, "secondary")
aimButton = make("TextButton", {Name = "Aim", Size = UDim2.new(1, 0, 0, 32), Text = "Aim with phone: on", LayoutOrder = 7}, root) :: TextButton
styleButton(aimButton, "secondary")

local function updateControlState()
	if playButton then playButton.Text = previewing and "Stop preview" or "Preview cutscene in Studio" end
	if stopButton then
		local busy = previewing or recording
		stopButton.Text = busy and "Stop preview / recording" or "Nothing playing"
		stopButton.BackgroundColor3 = busy and PAL.danger or PAL.raised
		stopButton.BorderSizePixel = busy and 0 or 1
		stopButton.TextColor3 = busy and PAL.onAccent or PAL.muted
	end
	if aimButton then
		aimButton.Text = liveAim and "Aim with phone: on" or "Aim with phone: off"
		aimButton.BackgroundColor3 = PAL.raised
		aimButton.BorderSizePixel = 1
		aimButton.BorderColor3 = liveAim and PAL.live or PAL.lineStrong
		aimButton.TextColor3 = liveAim and PAL.live or PAL.muted
	end
end
updateControlState()
installRuntimeButton = make("TextButton", {Name = "InstallRuntime", Size = UDim2.new(1, 0, 0, 36), Text = "Install player runtime to game", LayoutOrder = 8}, root) :: TextButton
styleButton(installRuntimeButton, "secondary")
installRuntimeButton.TextColor3 = PAL.text2
local triggerButton = make("TextButton", {Name = "TouchTrigger", Size = UDim2.new(1, 0, 0, 36), Text = "Add touch trigger to place", LayoutOrder = 9}, root) :: TextButton
styleButton(triggerButton, "secondary")
make("TextLabel", {Name = "Hint", BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 76), Font = Enum.Font.Gotham, Text = "Preview runs in Studio edit mode, without entering Play. Camera takes are editable rotational keyframes saved to the place under CineflowData.", TextColor3 = PAL.muted, TextSize = 10, TextWrapped = true, TextXAlignment = Enum.TextXAlignment.Left, LayoutOrder = 9}, root)

local function setStatus(message: string)
	if stateLabel then stateLabel.Text = message end
end

local function getSelectedModel(): Model?
	for _, instance in Selection:Get() do
		if instance:IsA("Model") then return instance end
		local ancestor = instance:FindFirstAncestorOfClass("Model")
		if ancestor then return ancestor end
	end
	return nil
end

local function animatorFor(model: Model): Animator?
	local animator = model:FindFirstChildWhichIsA("Animator", true)
	if animator then return animator end
	local controller = model:FindFirstChildOfClass("AnimationController") or model:FindFirstChildOfClass("Humanoid")
	if not controller then
		local changeId = ChangeHistoryService:TryBeginRecording("CineflowAddAnimator", "Prepare rig for Cineflow preview")
		if not changeId then return nil end
		controller = Instance.new("AnimationController")
		controller.Name = "AnimationController"
		controller.Parent = model
		local created = Instance.new("Animator")
		created.Parent = controller
		ChangeHistoryService:FinishRecording(changeId, Enum.FinishRecordingOperation.Commit)
		return created
	end
	local newAnimator = Instance.new("Animator")
	newAnimator.Parent = controller
	return newAnimator
end

local function findRig(name: string): Model?
	if name == "" then return getSelectedModel() end
	local found = Workspace:FindFirstChild(name, true)
	if found and found:IsA("Model") then return found end
	return getSelectedModel()
end

local function findCameraKeys()
	local keys = {}
	if not cutscene or type(cutscene.tracks) ~= "table" then return keys end
	for _, track in ipairs(cutscene.tracks) do
		if track.type == "camera" then
			for _, clip in ipairs(track.clips or {}) do
				local start = tonumber(clip.start) or 0
				if type(clip.keyframes) == "table" then
					for _, frame in ipairs(clip.keyframes) do
						if type(frame.rotation) == "table" then table.insert(keys, {time = start + (tonumber(frame.time) or 0), rotation = frame.rotation, fov = tonumber(frame.fov), base = clip.base}) end
					end
				elseif type(clip.rotation) == "table" then
					table.insert(keys, {time = start, rotation = clip.rotation, fov = tonumber(clip.fov), base = clip.base})
				end
			end
		end
	end
	table.sort(keys, function(a, b) return a.time < b.time end)
	return keys
end

-- Idle aim: when aim mode is on and nothing is previewing, the phone drives the
-- camera directly from a fixed base pose, so you can frame a shot before recording.
local aimConnection: RBXScriptConnection? = nil
local aimBase: CFrame? = nil

local function stopAimRender()
	if aimConnection then aimConnection:Disconnect(); aimConnection = nil end
	local camera = Workspace.CurrentCamera
	if aimBase and camera then camera.CFrame = aimBase end
	aimBase = nil
end

local function startAimRender()
	if aimConnection then return end
	local camera = Workspace.CurrentCamera
	if not camera then return end
	aimBase = camera.CFrame
	aimConnection = RunService.Heartbeat:Connect(function()
		if previewing or recording or not liveAim then return end
		local live = liveRotation()
		local current = Workspace.CurrentCamera
		if not live or not current or not aimBase then return end
		current.CFrame = aimBase * CFrame.Angles(math.rad(live.beta or 0), math.rad(live.alpha or 0), math.rad(live.gamma or 0))
	end)
end

-- Exactly one source drives the camera at a time: the phone while aiming or
-- recording (so a take matches what you framed), the recorded keyframes while
-- previewing (so live phone aim can never bend playback or double-apply a take).
local function cameraCFrameAt(time: number): CFrame?
	local phoneMode = recording or (liveAim and not previewing)
	local live = phoneMode and liveRotation() or nil
	if live then
		return (oldCameraCFrame or CFrame.new()) * CFrame.Angles(math.rad(live.beta or 0), math.rad(live.alpha or 0), math.rad(live.gamma or 0))
	end
	if recording then return nil end
	if #cameraKeyframes == 0 then return nil end
	local before = cameraKeyframes[1]
	local after = cameraKeyframes[#cameraKeyframes]
	for _, key in ipairs(cameraKeyframes) do
		if key.time <= time then before = key end
		if key.time >= time then after = key break end
	end
	local alpha = after.time > before.time and math.clamp((time - before.time) / (after.time - before.time), 0, 1) or 0
	local a, b = before.rotation, after.rotation
	local from = CFrame.Angles(math.rad(tonumber(a.beta) or 0), math.rad(tonumber(a.alpha) or 0), math.rad(tonumber(a.gamma) or 0))
	local to = CFrame.Angles(math.rad(tonumber(b.beta) or 0), math.rad(tonumber(b.alpha) or 0), math.rad(tonumber(b.gamma) or 0))
	-- The recorded anchor wins over wherever the editor camera is now, so a take
	-- replays from the spot it was shot, never from the current viewport.
	local baseA = listToCFrame(before.base) or oldCameraCFrame or CFrame.new()
	local baseB = listToCFrame(after.base) or baseA
	return baseA:Lerp(baseB, alpha) * from:Lerp(to, alpha)
end

local function saveTake()
	if not cutscene or #samples == 0 then return end
	--- The anchor is captured when recording starts, so it is the exact spot the
	--- take was framed from rather than wherever the camera drifted to since.
	cameraAnchor = cameraAnchor or oldCameraCFrame
	local folder = Workspace:FindFirstChild("CineflowData")
	if not folder then folder = Instance.new("Folder"); folder.Name = "CineflowData"; folder.Parent = Workspace end
	local takeFolder = folder:FindFirstChild(tostring(cutscene.id or "Cutscene"))
	if not takeFolder then takeFolder = Instance.new("Folder"); takeFolder.Name = tostring(cutscene.id or "Cutscene"); takeFolder.Parent = folder end
	local take = {id = "take-" .. tostring(DateTime.now().UnixTimestampMillis), name = "Phone Camera Take", createdAt = DateTime.now().UnixTimestamp, samples = samples, base = cameraAnchor and cframeToList(cameraAnchor) or nil}
	local value = Instance.new("StringValue")
	value.Name = take.id
	value.Value = HttpService:JSONEncode(take)
	value.Parent = takeFolder
	if baseUrl and token then pcall(function() HttpService:PostAsync(baseUrl .. "/plugin/event?token=" .. HttpService:UrlEncode(token :: string), HttpService:JSONEncode({type = "take-saved", take = take}), Enum.HttpContentType.ApplicationJson) end) end
	setStatus("Take saved in Workspace.CineflowData")
end

local function stopPreview(saveRecording: boolean?)
	if saveRecording and recording then saveTake() end
	previewing = false
	recording = false
	sampleStartTimestamp = nil
	lastTakeMotionSequence = lastMotionSequence
	if previewConnection then previewConnection:Disconnect(); previewConnection = nil end
	for _, entry in ipairs(animationEntries) do
		if entry.track then pcall(function() entry.track:Stop(0.15) end); entry.track = nil end
	end
	previewModels = {}
	local camera = Workspace.CurrentCamera
	if camera then
		if oldCameraType then camera.CameraType = oldCameraType end
		if oldCameraSubject and oldCameraSubject.Parent then camera.CameraSubject = oldCameraSubject end
		if oldCameraCFrame then camera.CFrame = oldCameraCFrame end
		if oldCameraFov then camera.FieldOfView = oldCameraFov end
	end
	oldCameraType, oldCameraSubject, oldCameraCFrame, oldCameraFov = nil, nil, nil, nil
	setStatus("Preview stopped — editing mode")
	updateControlState()
	if liveAim and widget.Enabled then startAimRender() end
end

local function startPreview(isRecording: boolean, startAt: number?)
	if not cutscene then setStatus("No active cutscene received from desktop app"); return end
	if recording then saveTake() end
	stopPreview(false)
	local camera = Workspace.CurrentCamera
	if camera then oldCameraType = camera.CameraType; oldCameraSubject = camera.CameraSubject; oldCameraCFrame = camera.CFrame; oldCameraFov = camera.FieldOfView; camera.CameraType = Enum.CameraType.Scriptable end
	if isRecording and oldCameraCFrame then
		cameraAnchor = oldCameraCFrame
		markAnchor(oldCameraCFrame)
	end
	cameraKeyframes = findCameraKeys()
	local offset = math.max(0, startAt or 0)
	previewStartedAt = os.clock() - offset
	previewPlayhead = offset
	previewing = true
	recording = isRecording
	samples = {}
	sampleStartTimestamp = nil
	lastTakeMotionSequence = lastMotionSequence
	stopAimRender()
	setStatus(isRecording and "Recording editable phone camera take…" or "Preview running — edit mode, not Play mode — phone aim is ignored")
	updateControlState()
	animationEntries = {}
	local maximum = tonumber(cutscene.duration) or 0
	for _, trackData in ipairs(cutscene.tracks or {}) do
		if trackData.type == "animation" then
			for _, clip in ipairs(trackData.clips or {}) do
				local startTime = tonumber(clip.start) or 0
				local duration = tonumber(clip.duration) or 0
				maximum = math.max(maximum, startTime + duration)
				table.insert(animationEntries, {clip = clip, startTime = startTime, endTime = startTime + duration, started = false, track = nil})
			end
		end
	end
	previewConnection = RunService.Heartbeat:Connect(function(delta)
		if not previewing then return end
		previewPlayhead = os.clock() - previewStartedAt
		for _, model in pairs(previewModels) do
			local animator = model:FindFirstChildWhichIsA("Animator", true)
			if animator then pcall(function() animator:StepAnimations(delta) end) end
		end
		for _, entry in ipairs(animationEntries) do
			local clip = entry.clip
			if previewPlayhead >= entry.startTime and not entry.started then
				entry.started = true
				local model = findRig(tostring(clip.rig or ""))
				local id = tostring(clip.assetId or "")
				if model and id:match("%d+") then
					local animator = animatorFor(model)
					if animator then
						local animation = Instance.new("Animation")
					animation.AnimationId = id:find("rbxassetid://", 1, true) and id or "rbxassetid://" .. id
					local ok, animationTrack = pcall(function() return animator:LoadAnimation(animation) end)
					if ok and animationTrack then
						animationTrack:Play(0.1)
						animationTrack.Looped = false
						entry.track = animationTrack
						previewModels[model:GetFullName()] = model
					end
					end
				end
			end
			if entry.track and previewPlayhead >= entry.endTime then entry.track:Stop(0.1); entry.track = nil end
		end
		local cframe = cameraCFrameAt(previewPlayhead)
		if cframe and Workspace.CurrentCamera then
			Workspace.CurrentCamera.CFrame = cframe
			for _, key in ipairs(cameraKeyframes) do if key.time <= previewPlayhead and key.fov then Workspace.CurrentCamera.FieldOfView = key.fov end end
		end
		if not recording and previewPlayhead > maximum + 0.1 then stopPreview(false) end
	end)
end

local function installRuntime()
	local changeId = ChangeHistoryService:TryBeginRecording("CineflowInstallRuntime", "Install Cineflow player runtime")
	if not changeId then setStatus("Could not start an undoable Studio change"); return end
	local serverScriptService = game:GetService("ServerScriptService")
	local replicatedStorage = game:GetService("ReplicatedStorage")
	local dataFolder = replicatedStorage:FindFirstChild("CineflowCutscenes") or Instance.new("Folder")
	dataFolder.Name = "CineflowCutscenes"
	dataFolder.Parent = replicatedStorage
	local cameraEvent = replicatedStorage:FindFirstChild("CineflowPlayCamera")
	if not cameraEvent or not cameraEvent:IsA("RemoteEvent") then
		cameraEvent = Instance.new("RemoteEvent")
		cameraEvent.Name = "CineflowPlayCamera"
		cameraEvent.Parent = replicatedStorage
	end
	local starterPlayer = game:GetService("StarterPlayer")
	local starterScripts = starterPlayer:FindFirstChildOfClass("StarterPlayerScripts")
	if not starterScripts then starterScripts = Instance.new("StarterPlayerScripts"); starterScripts.Parent = starterPlayer end
	local cameraClient = starterScripts:FindFirstChild("CineflowCameraRuntime")
	if not cameraClient or not cameraClient:IsA("LocalScript") then cameraClient = Instance.new("LocalScript"); cameraClient.Name = "CineflowCameraRuntime" end
	cameraClient.Source = [[
-- Generated by Cineflow Studio. Plays editable camera rotation keyframes for one client.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local RunService = game:GetService("RunService")
local event = ReplicatedStorage:WaitForChild("CineflowPlayCamera")
local generation = 0
local function angleFrame(rotation)
	return CFrame.Angles(math.rad(tonumber(rotation.beta) or 0), math.rad(tonumber(rotation.alpha) or 0), math.rad(tonumber(rotation.gamma) or 0))
end
local function baseFrame(list)
	if type(list) ~= "table" or #list < 12 then return nil end
	for index = 1, 12 do if tonumber(list[index]) == nil then return nil end end
	return CFrame.new(tonumber(list[1]), tonumber(list[2]), tonumber(list[3]), tonumber(list[4]), tonumber(list[5]), tonumber(list[6]), tonumber(list[7]), tonumber(list[8]), tonumber(list[9]), tonumber(list[10]), tonumber(list[11]), tonumber(list[12]))
end
local function cameraKeys(cutscene)
	local keys = {}
	for _, track in ipairs(cutscene.tracks or {}) do
		if track.type == "camera" then
			for _, clip in ipairs(track.clips or {}) do
				local start = tonumber(clip.start) or 0
				if type(clip.keyframes) == "table" then
					for _, frame in ipairs(clip.keyframes) do
						if type(frame.rotation) == "table" then table.insert(keys, {time = start + (tonumber(frame.time) or 0), rotation = frame.rotation, base = clip.base}) end
					end
				elseif type(clip.rotation) == "table" then table.insert(keys, {time = start, rotation = clip.rotation, base = clip.base}) end
			end
		end
	end
	table.sort(keys, function(a, b) return a.time < b.time end)
	return keys
end
event.OnClientEvent:Connect(function(cutscene)
	generation += 1
	local thisGeneration = generation
	local keys = cameraKeys(cutscene)
	if #keys == 0 then return end
	local camera = workspace.CurrentCamera
	if not camera then return end
	local oldType, oldSubject, oldCFrame, oldFov = camera.CameraType, camera.CameraSubject, camera.CFrame, camera.FieldOfView
-- A camera take replays from the vantage it was recorded from, not from wherever
	-- this player's camera happened to be when the cutscene started.
	local origin = baseFrame(keys[1].base) or camera.CFrame
	local finish = math.max(tonumber(cutscene.duration) or 0, keys[#keys].time)
	local started = os.clock()
	camera.CameraType = Enum.CameraType.Scriptable
	local connection
	local function restore()
		if connection then connection:Disconnect(); connection = nil end
		if workspace.CurrentCamera == camera then
			camera.CameraType = oldType
			if oldSubject and oldSubject.Parent then camera.CameraSubject = oldSubject end
			camera.CFrame = oldCFrame
			camera.FieldOfView = oldFov
		end
	end
	connection = RunService.RenderStepped:Connect(function()
		if thisGeneration ~= generation then restore(); return end
		local time = os.clock() - started
		local before, after = keys[1], keys[#keys]
		for _, key in ipairs(keys) do
			if key.time <= time then before = key end
			if key.time >= time then after = key break end
		end
		local alpha = after.time > before.time and math.clamp((time - before.time) / (after.time - before.time), 0, 1) or 0
		camera.CFrame = origin * angleFrame(before.rotation):Lerp(angleFrame(after.rotation), alpha)
		if time >= finish then restore() end
	end)
end)
]]
	cameraClient.Parent = starterScripts
	local module = serverScriptService:FindFirstChild("CineflowRuntime")
	if not module or not module:IsA("ModuleScript") then module = Instance.new("ModuleScript"); module.Name = "CineflowRuntime" end
	module.Source = [[
-- Generated by Cineflow Studio. Plays animation and trigger clips saved as a JSON StringValue.
local Runtime = {}
local function getTrack(rig, animationId)
	local animator = rig:FindFirstChildWhichIsA("Animator", true)
	if not animator then
		local controller = rig:FindFirstChildOfClass("AnimationController") or rig:FindFirstChildOfClass("Humanoid")
		if not controller then controller = Instance.new("AnimationController"); controller.Parent = rig end
		animator = Instance.new("Animator"); animator.Parent = controller
	end
	local animation = Instance.new("Animation")
	animation.AnimationId = tostring(animationId):find("rbxassetid://", 1, true) and tostring(animationId) or "rbxassetid://" .. tostring(animationId)
	return animator:LoadAnimation(animation)
end
function Runtime.Play(cutscene)
	local started = os.clock()
	local active, fired = {}, {}
	local total = tonumber(cutscene.duration) or 0
	for _, track in ipairs(cutscene.tracks or {}) do
		for _, clip in ipairs(track.clips or {}) do total = math.max(total, (tonumber(clip.start) or 0) + (tonumber(clip.duration) or 0)) end
	end
	while os.clock() - started <= total do
		local now = os.clock() - started
		for ti, track in ipairs(cutscene.tracks or {}) do
			for ci, clip in ipairs(track.clips or {}) do
				local key = tostring(ti) .. ":" .. tostring(ci)
				if not fired[key] and now >= (tonumber(clip.start) or 0) then
					fired[key] = true
					if track.type == "animation" then
						local rig = workspace:FindFirstChild(tostring(clip.rig or ""), true)
						if rig and rig:IsA("Model") then local animTrack = getTrack(rig, clip.assetId); animTrack:Play(); active[key] = animTrack end
					elseif track.type == "trigger" then
						local part = workspace:FindFirstChild(tostring(clip.triggerPart or ""), true)
						if part and part:IsA("BasePart") then part:SetAttribute("CineflowTriggered", now) end
					end
				end
				local playing = active[key]
				if playing and now >= (tonumber(clip.start) or 0) + (tonumber(clip.duration) or 0) then playing:Stop(); active[key] = nil end
			end
		end
		task.wait()
	end
	for _, track in pairs(active) do track:Stop() end
end
function Runtime.PlaySaved(name)
	local folder = game:GetService("ReplicatedStorage"):FindFirstChild("CineflowCutscenes")
	local value = folder and folder:FindFirstChild(name)
	assert(value and value:IsA("StringValue"), "Cineflow cutscene data not found")
	return Runtime.Play(game:GetService("HttpService"):JSONDecode(value.Value))
end
function Runtime.PlayForPlayer(cutscene, player)
	local event = game:GetService("ReplicatedStorage"):FindFirstChild("CineflowPlayCamera")
	if event and event:IsA("RemoteEvent") and player then event:FireClient(player, cutscene) end
	return Runtime.Play(cutscene)
end
function Runtime.PlaySavedForPlayer(name, player)
	local folder = game:GetService("ReplicatedStorage"):FindFirstChild("CineflowCutscenes")
	local value = folder and folder:FindFirstChild(name)
	assert(value and value:IsA("StringValue"), "Cineflow cutscene data not found")
	return Runtime.PlayForPlayer(game:GetService("HttpService"):JSONDecode(value.Value), player)
end
return Runtime
]]
	module.Parent = serverScriptService
	if cutscene then
		local dataName = tostring(cutscene.id or "Cutscene"):gsub("[^%w_-]", "_")
		local dataValue = dataFolder:FindFirstChild(dataName)
		if not dataValue or not dataValue:IsA("StringValue") then
			dataValue = Instance.new("StringValue")
			dataValue.Name = dataName
			dataValue.Parent = dataFolder
		end
		dataValue.Value = HttpService:JSONEncode(cutscene)
	end
	ChangeHistoryService:FinishRecording(changeId, Enum.FinishRecordingOperation.Commit)
	setStatus("Player runtime installed in ServerScriptService")
end

-- Builds everything a game needs for "walk into this and the cutscene plays":
-- the shared runtime, the saved cutscene data, a visible pad, a ProximityPrompt
-- and a small server script. One click instead of hand-wiring three services.
local function installTouchTrigger()
	if not cutscene then
		setStatus("Pick a cutscene in the desktop app first, then add the trigger")
		return
	end
	installRuntime()
	local cutsceneName = tostring(cutscene.id or "Cutscene")
	local changeId = ChangeHistoryService:TryBeginRecording("CineflowAddTouchTrigger", "Add Cineflow touch trigger")
	if not changeId then setStatus("Could not start an undoable Studio change"); return end
	local folder = Workspace:FindFirstChild("CineflowData") or Instance.new("Folder")
	folder.Name = "CineflowData"
	folder.Parent = Workspace
	local pad = folder:FindFirstChild("TouchTrigger")
	if not pad or not pad:IsA("BasePart") then
		local camera = Workspace.CurrentCamera
		local origin = camera and camera.CFrame or CFrame.new(0, 5, 0)
		local position = (origin * CFrame.new(0, -3, -12)).Position
		pad = Instance.new("Part")
		pad.Name = "TouchTrigger"
		pad.Size = Vector3.new(8, 0.6, 8)
		pad.Anchored = true
		pad.CanCollide = false
		pad.Material = Enum.Material.Neon
		pad.Color = Color3.fromRGB(126, 207, 171)
		pad.Transparency = 0.25
		pad.CFrame = CFrame.new(position)
		pad.Parent = folder
	end
	local padPart = pad :: BasePart
	local prompt = padPart:FindFirstChildOfClass("ProximityPrompt")
	if not prompt then
		prompt = Instance.new("ProximityPrompt")
		prompt.ActionText = "Watch cutscene"
		prompt.ObjectText = tostring(cutscene.name or "Cutscene")
		prompt.HoldDuration = 0
		prompt.MaxActivationDistance = 12
		prompt.RequiresLineOfSight = false
		prompt.Parent = padPart
	end
	(prompt :: ProximityPrompt).ObjectText = tostring(cutscene.name or "Cutscene")
	local scriptSource = string.format([[
-- Generated by Cineflow Studio for the cutscene %q.
-- To set this up by hand or with an AI in Studio:
--   1. ReplicatedStorage.CineflowCutscenes.<name>   holds the cutscene JSON (StringValue)
--   2. ServerScriptService.CineflowRuntime          plays it (ModuleScript)
--   3. This script requires the module and calls Runtime.PlaySavedForPlayer(NAME, player)
-- Change CUTSCENE to any StringValue name in ReplicatedStorage.CineflowCutscenes.
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local ServerScriptService = game:GetService("ServerScriptService")

local CUTSCENE = %q
local COOLDOWN = 6
local Runtime = require(ServerScriptService:WaitForChild("CineflowRuntime"))
local pad = script.Parent
local prompt = pad:FindFirstChildOfClass("ProximityPrompt")
local lastPlayed = {}

local function play(player)
	if not player or player.Parent ~= Players then return end
	local now = os.clock()
	if now - (lastPlayed[player] or -math.huge) < COOLDOWN then return end
	lastPlayed[player] = now
	task.spawn(function()
		local ok, err = pcall(function() return Runtime.PlaySavedForPlayer(CUTSCENE, player) end)
		if not ok then warn("[Cineflow] " .. tostring(err)) end
	end)
end

pad.Touched:Connect(function(hit)
	local character = hit.Parent
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if not humanoid then return end
	play(Players:GetPlayerFromCharacter(character))
end)

if prompt then prompt.Triggered:Connect(play) end
]], cutsceneName, cutsceneName)
	local triggerScript = padPart:FindFirstChild("CineflowTrigger")
	if not triggerScript or not triggerScript:IsA("Script") then
		triggerScript = Instance.new("Script")
		triggerScript.Name = "CineflowTrigger"
		triggerScript.Parent = padPart
	end
	(triggerScript :: Script).Source = scriptSource
	ChangeHistoryService:FinishRecording(changeId, Enum.FinishRecordingOperation.Commit)
	Selection:Set({padPart})
	setStatus("Touch trigger added — walk onto CineflowData.TouchTrigger in play mode")
end

-- A visible block in the workspace marking where a take was recorded from, so
-- the anchor is a physical thing you can look at instead of hidden state.
function markAnchor(cf: CFrame)
	local changeId = ChangeHistoryService:TryBeginRecording("CineflowMarkAnchor", "Mark Cineflow camera anchor")
	local folder = Workspace:FindFirstChild("CineflowData")
	if not folder then folder = Instance.new("Folder"); folder.Name = "CineflowData"; folder.Parent = Workspace end
	local marker = folder:FindFirstChild("CameraAnchor")
	if not marker or not marker:IsA("Part") then
		marker = Instance.new("Part")
		marker.Name = "CameraAnchor"
		marker.Size = Vector3.new(1.4, 1.4, 1.4)
		marker.Anchored = true
		marker.CanCollide = false
		marker.CanQuery = false
		marker.CastShadow = false
		marker.Material = Enum.Material.Neon
		marker.Color = Color3.fromRGB(255, 96, 122)
		marker.Transparency = 0.2
		marker.Parent = folder
	end
	marker.CFrame = cf
	if changeId then ChangeHistoryService:FinishRecording(changeId, Enum.FinishRecordingOperation.Commit) end
end

-- Studio cannot hand a plugin rendered pixels, so the app's proxy viewfinder gets
-- the live camera transform plus the nearest geometry and draws it itself.
local sceneSnapshot: {any} = {}
local sceneSnapshotAt = 0

local function captureScene(): {any}
	local camera = Workspace.CurrentCamera
	if not camera then return {} end
	local origin = camera.CFrame.Position
	local items = {}
	local visited = 0
	for _, item in ipairs(Workspace:GetDescendants()) do
		visited += 1
		if visited > 8000 then break end
		if item:IsA("BasePart") and item.Transparency < 0.92 and item ~= camera then
			local distance = (item.Position - origin).Magnitude
			if distance < 220 then
				local color = item.Color
				table.insert(items, {cf = cframeToList(item.CFrame), size = {item.Size.X, item.Size.Y, item.Size.Z}, color = {color.R, color.G, color.B}, distance = distance, name = item.Name, kind = if item.Name == "CameraAnchor" then "anchor" else "part"})
			end
		end
	end
	table.sort(items, function(a, b) return a.distance < b.distance end)
	while #items > 48 do table.remove(items) end
	return items
end

local function pushPreviewFrame()
	if not (baseUrl and token) then return end
	if not previewing then
		if previewWasPushing then
			previewWasPushing = false
			local url = baseUrl .. "/plugin/event?token=" .. HttpService:UrlEncode(token :: string)
			pcall(function() HttpService:PostAsync(url, HttpService:JSONEncode({type = "preview-frame", preview = {active = false}}), Enum.HttpContentType.ApplicationJson) end)
		end
		return
	end
	local now = os.clock()
	if now - previewPushAt < 0.09 then return end
	previewPushAt = now
	local camera = Workspace.CurrentCamera
	if not camera then return end
	if now - sceneSnapshotAt > 1.5 then
		sceneSnapshotAt = now
		sceneSnapshot = captureScene()
	end
	previewWasPushing = true
	local payload = {
		type = "preview-frame",
		preview = {
			active = true,
			recording = recording,
			time = math.max(0, previewPlayhead),
			cf = cframeToList(camera.CFrame),
			fov = camera.FieldOfView,
			parts = sceneSnapshot,
		},
	}
	local url = baseUrl .. "/plugin/event?token=" .. HttpService:UrlEncode(token :: string)
	pcall(function() HttpService:PostAsync(url, HttpService:JSONEncode(payload), Enum.HttpContentType.ApplicationJson) end)
end

local function pollBridge()
	if not baseUrl or not token then return end
	local url = baseUrl .. "/plugin/poll?token=" .. HttpService:UrlEncode(token)
	local ok, response = pcall(function() return HttpService:GetAsync(url, true) end)
	if not ok then
		setRow("desktop", "Desktop bridge — unreachable", false)
		setRow("studio", "Studio link — retrying", false)
		setStatus("Desktop bridge unavailable — keep the Cineflow app running, then Connect again")
		return
	end
	local decodedOk, data = pcall(function() return HttpService:JSONDecode(response) end)
	if not decodedOk then setStatus("Invalid bridge response"); return end
	if data.cutscene and (data.cutscene.id ~= (cutscene and cutscene.id) or data.cutsceneRevision ~= cutsceneRevision) then
		cutscene = data.cutscene
		cutsceneRevision = data.cutsceneRevision
	end
	if data.motion and tonumber(data.motionSequence) ~= lastMotionSequence then
		lastMotionSequence = tonumber(data.motionSequence) or lastMotionSequence
		pushMotion(tonumber(data.motion.alpha) or 0, tonumber(data.motion.beta) or 0, tonumber(data.motion.gamma) or 0)
	end
	if data.motionBatch and #data.motionBatch > 0 then
		for _, sample in ipairs(data.motionBatch) do
			local sequence = tonumber(sample.sequence) or 0
			lastMotionSequence = math.max(lastMotionSequence, sequence)
			local sampleAlpha = tonumber(sample.alpha) or 0
			local sampleBeta = tonumber(sample.beta) or 0
			local sampleGamma = tonumber(sample.gamma) or 0
			pushMotion(sampleAlpha, sampleBeta, sampleGamma)
			if recording and sequence > lastTakeMotionSequence then
				local timestamp = tonumber(sample.timestamp) or DateTime.now().UnixTimestampMillis
				if not sampleStartTimestamp then sampleStartTimestamp = timestamp end
				table.insert(samples, {time = math.max(0, (timestamp - sampleStartTimestamp) / 1000), alpha = sampleAlpha, beta = sampleBeta, gamma = sampleGamma, timestamp = timestamp})
				lastTakeMotionSequence = sequence
			end
		end
	end
	for _, command in ipairs(data.commands or {}) do
		if command.type == "preview" then startPreview(false, tonumber(command.start))
		elseif command.type == "stop-preview" then stopPreview(false)
		elseif command.type == "calibrate" then
			clearMotion()
			local camera = Workspace.CurrentCamera
			if camera then oldCameraCFrame = camera.CFrame; aimBase = camera.CFrame end
			setStatus("Camera neutral pose reset")
		elseif command.type == "record" then startPreview(true)
		elseif command.type == "stop-record" then stopPreview(true) end
	end
	setRow("desktop", "Desktop bridge — connected", true)
	setRow("studio", "Studio link — live (this plugin)", true)
	if data.phoneConnected then
		setRow("phone", recording and "Phone camera — recording take" or previewing and "Phone camera — streaming (ignored during preview)" or "Phone camera — streaming", true)
		lastPhoneConnected = true
	else
		-- A phone that vanished must not keep bending the camera with a stale pose.
		if lastPhoneConnected then clearMotion() end
		lastPhoneConnected = false
		setRow("phone", "Phone camera — offline (scan the QR in the app)", nil)
	end
	if cutscene then
		local clipCount = 0
		for _, track in ipairs(cutscene.tracks or {}) do clipCount += #(track.clips or {}) end
		setRow("cutscene", string.format("%s — %d clips · %.1fs", tostring(cutscene.name or "Cutscene"), clipCount, tonumber(cutscene.duration) or 0), true)
	else
		setRow("cutscene", "Cutscene — none loaded (pick one in the app)", nil)
	end
	if data.phoneConnected then setStatus(recording and "Recording editable camera take…" or previewing and "Preview running — edit mode" or "Connected — phone camera ready") else setStatus("Connected — scan QR with phone") end
	pushPreviewFrame()
end

local function connectToDesktop()
	local success, response = pcall(function() return HttpService:GetAsync("http://127.0.0.1:41837/plugin/config", true) end)
	if not success then
		local message = tostring(response):gsub("^.*:%d+: ", "")
		local lowered = string.lower(message)
		if lowered:find("refused", 1, true) or lowered:find("10061", 1, true) or lowered:find("unabletoconnect", 1, true) or lowered:find("unable to connect", 1, true) or lowered:find("connectfail", 1, true) or lowered:find("no connection", 1, true) then
			setStatus("Desktop bridge is offline — click 'Start phone bridge' in the Cineflow app, then Connect again")
		elseif lowered:find("not enabled", 1, true) or lowered:find("http requests", 1, true) then
			setStatus("Enable Allow HTTP Requests in Experience Settings > Security")
		elseif lowered:find("permission", 1, true) or lowered:find("denied", 1, true) or lowered:find("not allowed", 1, true) then
			setStatus("Studio blocked this plugin's network access — allow it in the prompt or Plugin Management, then Connect again")
		else
			setStatus("Connect failed: " .. string.sub(message, 1, 90))
		end
		return
	end
	local decodedOk, config = pcall(function() return HttpService:JSONDecode(response) end)
	if not decodedOk or type(config.token) ~= "string" then setStatus("Invalid desktop bridge configuration"); return end
	baseUrl = "http://127.0.0.1:" .. tostring(config.port)
	token = config.token
	connectButton.Text = "Connected to desktop"
	styleConnected(connectButton)
	setRow("desktop", "Desktop bridge — connected", true)
	setRow("studio", "Studio link — live (this plugin)", true)
	if liveAim then startAimRender() end
	setStatus("Connected — waiting for phone and active cutscene")
	pollBridge()
end

connectButton.Activated:Connect(connectToDesktop)
playButton.Activated:Connect(function() if previewing then stopPreview(false) else startPreview(false) end end)
stopButton.Activated:Connect(function() if previewing or recording then stopPreview(true) end end)
aimButton.Activated:Connect(function()
	liveAim = not liveAim
	if liveAim then
		startAimRender()
		setStatus("Phone aim on — move the phone to frame the camera")
	else
		clearMotion()
		stopAimRender()
		setStatus("Phone aim off — the camera ignores the phone")
	end
	updateControlState()
end)
installRuntimeButton.Activated:Connect(installRuntime)
triggerButton.Activated:Connect(function()
	triggerButton.Text = "Building trigger…"
	installTouchTrigger()
	triggerButton.Text = "Add touch trigger to place"
end)
task.spawn(function()
	while true do
		-- Poll fast only while phone input can actually affect the view; the idle
		-- link stays cheap so it does not compete with Studio.
		local busy = previewing or recording or (liveAim and lastPhoneConnected)
		task.wait(busy and 0.05 or 0.2)
		if baseUrl then pollBridge() end
	end
end)
widget:GetPropertyChangedSignal("Enabled"):Connect(function() if not widget.Enabled and previewing then stopPreview(true) end end)
plugin.Unloading:Connect(function() stopPreview(true) end)
openButton.Click:Connect(function() widget.Enabled = not widget.Enabled end)
