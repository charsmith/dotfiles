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
	clean_link_file $i $1
done

source="${PWD}/_vim/_vimrc"
target="${1}/.vimrc"
link_file $source $target 

rm -rf _vim/bundle/*

cat submodules | perl -e 'while(<>){($a,$b) = split(/\s+/, $_); print `git clone $a $b`;}'
