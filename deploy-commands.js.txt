require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Open the application system configuration dashboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('deploy')
        .setDescription('Send the application panel to the current channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Deploying commands...');
        // This clears global commands and pushes the new ones
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('Commands deployed successfully. Restart your Discord client (Ctrl+R) to see them.');
    } catch (error) {
        console.error(error);
    }
})();