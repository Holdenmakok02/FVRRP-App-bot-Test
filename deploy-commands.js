require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('help')
        .setDescription('View a list of all bot commands and what they do'),
    new SlashCommandBuilder()
        .setName('dashboard')
        .setDescription('Open the application system configuration dashboard')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('deploy')
        .setDescription('Send the application panel to the current channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('forceclose')
        .setDescription('Force close and delete this ticket channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('purge')
        .setDescription('Force close all completed application channels created by the bot')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('reset')
        .setDescription('Clear a user\'s pending application so they can reapply')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option => option.setName('user').setDescription('The user to reset').setRequired(true)),
    new SlashCommandBuilder()
        .setName('config')
        .setDescription('View the current bot configuration for this server')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_channels')
        .setDescription('Update the ticket category and logs channel')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_rules')
        .setDescription('Update the application rules')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_questions')
        .setDescription('Update the application questions')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_roles')
        .setDescription('Update the staff roles that can review applications')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_messages')
        .setDescription('Update the approval and denial messages')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('edit_panel')
        .setDescription('Update the panel description shown before applying')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

(async () => {
    try {
        console.log('Deploying commands...');
        await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands }
        );
        console.log('Commands deployed successfully.');
    } catch (error) {
        console.error(error);
    }
})();