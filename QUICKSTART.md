# Lighting Lab quick start`r`n`r`nOn Windows, double-click **Start Lighting Lab.cmd** to start the local server and open the editor. Keep its terminal window open while you use Lighting Lab.

1. Open `http://localhost:4318`. If PowerShell says port 4318 is already in use, Lighting Lab is
   already running; use the browser page instead of starting a second server.
2. Check the connected keyboard list and the preview model. A list item identifies the editor's
   model/profile target; the current generic Chroma SDK canvas is shared across compatible keyboards.
3. Choose Paint Anchor, Paint Background, or Paint Orientation, then click switches in the preview.
4. For every group choose a base color, dynamic effect, and reaction. Test reactions by clicking a
   switch in Test reactions mode or by typing in the test field.
5. Keep Live changes enabled for immediate Chroma writes. Use Apply to keyboard to force the exact
   preview when live edits are paused or after changing provider state.
6. Save as Profile stores an editable controller profile. Export Setup JSON stores a portable recipe.

Live Chroma effects are temporary and require the server to remain running. A successful controller
acknowledgement is not visual confirmation; use the physical confirmation controls after Apply.
