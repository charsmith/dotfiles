#!/usr/bin/env bash
function clean_link_file {
    source="${PWD}/$1"
    target="${2}/${1/_/.}"
	link_file $source $target
}

function link_file {
	source=$1
	target=$2

    #don't try to relink something
    if [ -h "${target}" ]; then
        return
    fi

    if [ -e "${target}" ]; then
        mv $target $target.bak
    fi

    ln -sf ${source} ${target}
}

for i in _*
do
	clean_link_file $i ${blah:-${HOME}}
done

link_file $source $target 


# Define the source directory (change this to your actual config directory)
SOURCE_DIR="$PWD/config"

# Check if ~/.config directory exists, create it if not
if [ ! -d "$HOME/.config" ]; then
  echo "Creating ~/.config directory..."
  mkdir -p "$HOME/.config"
else
  echo "~/.config directory already exists."
fi

# Link all files from the source directory to ~/.config/
for file in "$SOURCE_DIR"/*; do
  filename=$(basename "$file")
  ln -s "$file" "$HOME/.config/$filename"
  echo "Linked $file to $HOME/.config/$filename"
done

echo "All files linked successfully.".
